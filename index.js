import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import fetch from 'node-fetch';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import holiday_jp from 'japanese-holidays';

// サーバーの時刻をUTCではなく日本時間(JST)に固定する。
// これを最初に設定しないと、営業日計算や「朝9時」などの時刻指定が
// すべて9時間ずれてしまう(例: 9時指定のつもりが日本時間の18時になる)。
process.env.TZ = 'Asia/Tokyo';

// ============================================================
// config
// ============================================================
function required(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  return v;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Chatwork
  chatworkApiToken: required('CHATWORK_API_TOKEN'),
  chatworkRoomId: required('CHATWORK_ROOM_ID', '449047228'),
  holderAccountIds: (process.env.HOLDER_ACCOUNT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Google Sheets
  sheetId: required('SHEET_ID', '1wSDLfoGZ--GEQR3jWWzm_eAE_goMKKy1xLA-u4IumG0'),
  faqSheetGid: process.env.FAQ_SHEET_GID || '929625368',
  faqSheetName: process.env.FAQ_SHEET_NAME || null,
  pendingSheetName: process.env.PENDING_SHEET_NAME || 'Bot_Pending',
  // 「対応」という単語は回答文の中にも普通に出てくるため、見出し行の自動判定は
  // 誤検出しやすい。実際のシート構造(見出しは3行目)を既定値として直接指定する。
  faqHeaderRow: parseInt(process.env.FAQ_HEADER_ROW || '3', 10),
  // このシートには「質問列→回答列」の組が複数並んでいる(B列の質問にC〜F列が回答、
  // L列の質問(場面)にM〜P列が回答、など)。"質問列:回答列,回答列,...;質問列:回答列,..."
  // の形式で、セミコロン区切りで複数組を指定できる。各回答列は中身がある列を
  // すべて(複数あれば改行区切りで)つなげてその行の回答とする。
  faqBlocks: process.env.FAQ_BLOCKS || 'B:C,D,E,F;L:M,N,O,P',
  googleServiceAccountJson: required('GOOGLE_SERVICE_ACCOUNT_JSON'),

  // LLM
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',

  // Scheduling / auth
  cronSecret: required('CRON_SECRET', 'change-me'),
  followupAfterBusinessDays: parseInt(process.env.FOLLOWUP_AFTER_BUSINESS_DAYS || '1', 10),

  // Bot behaviour
  teachTriggerWord: process.env.TEACH_TRIGGER_WORD || '覚えて',

  // 自社サイト用の自動回答チャットページ(接客担当向け・質問する側)の共通パスワード。
  // 未設定の場合は誰でもページを開ける状態になる。
  chatPagePassword: process.env.CHAT_PAGE_PASSWORD || '',

  // プロモーター向け管理画面(回答する側)の共通パスワード。
  // 未設定の場合は誰でもページを開ける状態になる。
  promoterPagePassword: process.env.PROMOTER_PAGE_PASSWORD || '',
};

function assertConfig() {
  const missing = [];
  if (!config.chatworkApiToken) missing.push('CHATWORK_API_TOKEN');
  if (!config.googleServiceAccountJson) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!config.geminiApiKey) missing.push('GEMINI_API_KEY');
  if (config.holderAccountIds.length === 0) missing.push('HOLDER_ACCOUNT_IDS');
  if (missing.length) {
    throw new Error(
      `必要な環境変数が設定されていません: ${missing.join(', ')}\n.env.example を参考に .env を作成してください。`
    );
  }
}

// ============================================================
// chatwork
// ============================================================
const CW_BASE_URL = 'https://api.chatwork.com/v2';

async function cwFetch(path, options = {}) {
  const res = await fetch(`${CW_BASE_URL}${path}`, {
    ...options,
    headers: {
      'X-ChatWorkToken': config.chatworkApiToken,
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Chatwork API error ${res.status} on ${path}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

let cachedMe = null;
async function getMe() {
  if (cachedMe) return cachedMe;
  cachedMe = await cwFetch('/me');
  return cachedMe;
}

async function getNewMessages(roomId = config.chatworkRoomId) {
  const messages = await cwFetch(`/rooms/${roomId}/messages?force=0`);
  return messages || [];
}

async function getRoomMembers(roomId = config.chatworkRoomId) {
  return (await cwFetch(`/rooms/${roomId}/members`)) || [];
}

// 指定したメッセージがまだ存在するか(お客様が削除していないか)を確認する。
// 判定できない場合(Chatwork側の一時的なエラーなど)は、誤って催促を止めてしまわないよう
// 「存在する」扱いにする。
async function messageExists(messageId, roomId = config.chatworkRoomId) {
  if (!messageId) return true;
  const res = await fetch(`${CW_BASE_URL}/rooms/${roomId}/messages/${messageId}`, {
    headers: { 'X-ChatWorkToken': config.chatworkApiToken },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`メッセージ存在確認でエラーが発生しました(message_id=${messageId}): ${res.status} ${text}`);
    return true;
  }
  return true;
}

async function sendMessage(body, roomId = config.chatworkRoomId) {
  const params = new URLSearchParams({ body });
  return cwFetch(`/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
}

function mentionTag(accountId, name = '') {
  return `[To:${accountId}]${name ? name + 'さん' : ''}`;
}

async function replyToMessage({ roomId = config.chatworkRoomId, toAccountId, toMessageId, name = '', body }) {
  const rp = `[rp aid=${toAccountId} to=${roomId}-${toMessageId}]${name ? name + 'さん' : ''}\n`;
  return sendMessage(rp + body, roomId);
}

function isMentionToMe(messageBody, myAccountId) {
  if (!messageBody) return false;
  return messageBody.includes(`[To:${myAccountId}]`);
}

function parseReplyTarget(messageBody) {
  if (!messageBody) return null;
  const m = messageBody.match(/\[rp aid=(\d+) to=(\d+)-(\d+)\]/);
  if (!m) return null;
  return { toAccountId: m[1], roomId: m[2], toMessageId: m[3] };
}

function stripChatworkTags(body) {
  if (!body) return '';
  return body
    .replace(/\[rp aid=\d+ to=\d+-\d+\][^\n]*\n?/g, '')
    .replace(/\[To:\d+\][^\s]*/g, '')
    .replace(/\[qt\][\s\S]*?\[\/qt\]/g, '')
    .trim();
}

// ============================================================
// sheets
// ============================================================
const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function loadCredentials() {
  const raw = config.googleServiceAccountJson;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON が設定されていません');
  if (!raw.trim().startsWith('{') && fs.existsSync(raw)) {
    return JSON.parse(fs.readFileSync(raw, 'utf8'));
  }
  if (!raw.trim().startsWith('{')) {
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON の形式を認識できません（JSON文字列 / base64 / ファイルパスのいずれかにしてください）');
    }
  }
  return JSON.parse(raw);
}

let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SHEETS_SCOPES });
  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  return sheetsClient;
}

let cachedFaqTitle = null;
// overrideGid / overrideName を渡すと、環境変数の設定に関係なく一時的に別タブを指定できる
// （/debug-sheet?gid=... や ?name=... でRenderを再デプロイせずに他タブを確認するために使用）。
async function resolveFaqSheetTitle(overrideGid, overrideName) {
  if (overrideName) return overrideName;
  if (overrideGid) {
    const sheets = await getSheets();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheetId });
    const target = meta.data.sheets.find((s) => String(s.properties.sheetId) === String(overrideGid));
    if (!target) {
      throw new Error(`gid=${overrideGid} に一致するシートタブが見つかりません。`);
    }
    return target.properties.title;
  }
  if (config.faqSheetName) return config.faqSheetName;
  if (cachedFaqTitle) return cachedFaqTitle;
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheetId });
  const target = meta.data.sheets.find(
    (s) => String(s.properties.sheetId) === String(config.faqSheetGid)
  );
  if (!target) {
    throw new Error(
      `gid=${config.faqSheetGid} に一致するシートタブが見つかりません。.env の FAQ_SHEET_NAME でタブ名を直接指定してください。`
    );
  }
  cachedFaqTitle = target.properties.title;
  return cachedFaqTitle;
}

async function listAllSheetTabs() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheetId });
  return meta.data.sheets.map((s) => ({
    title: s.properties.title,
    gid: String(s.properties.sheetId),
    rowCount: s.properties.gridProperties?.rowCount,
    columnCount: s.properties.gridProperties?.columnCount,
  }));
}

async function sheetTabExists(title) {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheetId });
  return meta.data.sheets.some((s) => s.properties.title === title);
}

const PENDING_HEADERS = [
  'ID',
  '質問',
  '質問者アカウントID',
  '質問者表示名',
  'ルームID',
  '質問メッセージID',
  'ホルダー依頼メッセージID',
  'ステータス',
  '依頼日時',
  '催促済み',
  '回答',
  '回答者',
  '回答日時',
];

async function ensurePendingSheetExists() {
  const title = config.pendingSheetName;
  const sheets = await getSheets();
  const exists = await sheetTabExists(title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [PENDING_HEADERS] },
    });
  }
}

function colLetterToIndex(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToColLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// FAQ_BLOCKS ("B:C,D,E,F;L:M,N,O,P" のような文字列) を、
// 質問列・回答列(複数可)の組の配列にパースする。
function parseFaqBlocks(raw) {
  return (raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((blockStr) => {
      const [qColRaw, aColsRaw] = blockStr.split(':');
      const questionCol = (qColRaw || '').trim();
      const answerCols = (aColsRaw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        questionCol,
        answerCols,
        questionColIndex: colLetterToIndex(questionCol),
        answerColIndexes: answerCols.map((c) => colLetterToIndex(c)),
      };
    })
    .filter((b) => b.questionCol && b.answerCols.length > 0);
}

async function readFaqTable(overrideGid, overrideName) {
  const title = await resolveFaqSheetTitle(overrideGid, overrideName);
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${title}`,
  });
  const values = res.data.values || [];
  const blocks = parseFaqBlocks(config.faqBlocks);

  if (values.length === 0 || blocks.length === 0) {
    return { title, headerRowIndex: 0, headerRow: [], blocks, rows: [] };
  }

  // 見出し行の位置。このシートでは複数の質問・回答列の組すべてが同じ見出し行(3行目)を
  // 共有している。
  const headerRowIndex = config.faqHeaderRow ? config.faqHeaderRow - 1 : 0;
  const header = values[headerRowIndex] || [];

  const rows = [];
  for (let i = headerRowIndex + 1; i < values.length; i++) {
    const row = values[i];
    for (const block of blocks) {
      const question = (row[block.questionColIndex] || '').trim();
      // 回答列が複数ある場合は、中身が入っている列をすべてつなげてその行の回答とする
      // （例: C列に短い回答、D列により詳しい回答が書かれているようなケースに対応）。
      // 2列以上に中身がある場合は、Chatworkの[info]枠で列ごとに見た目を分ける。
      const answerParts = block.answerColIndexes
        .map((idx) => (row[idx] || '').trim())
        .filter(Boolean);
      const answer =
        answerParts.length > 1
          ? answerParts.map((part) => `[info]\n${part}\n[/info]`).join('\n')
          : answerParts.join('');
      if (!question && !answer) continue;
      rows.push({ rowNumber: i + 1, question, answer, questionColumn: block.questionCol });
    }
  }
  return {
    title,
    headerRowIndex,
    headerRow: header,
    blocks,
    rows,
  };
}

async function appendFaqRow(question, answer) {
  const { title, blocks } = await readFaqTable();
  const primary = blocks[0] || { questionColIndex: 1, answerColIndexes: [2] };
  const sheets = await getSheets();
  const width = Math.max(primary.questionColIndex, ...primary.answerColIndexes) + 1;
  const row = new Array(width).fill('');
  row[primary.questionColIndex] = question;
  row[primary.answerColIndexes[0]] = answer;
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${title}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

async function appendPendingRow(entry) {
  await ensurePendingSheetExists();
  const sheets = await getSheets();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const row = [
    id,
    entry.question,
    entry.askerAccountId,
    entry.askerName || '',
    entry.roomId,
    entry.questionMessageId,
    entry.holderRequestMessageId,
    'pending',
    new Date().toISOString(),
    'no',
    '',
    '',
    '',
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${config.pendingSheetName}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return id;
}

async function listPendingRows() {
  await ensurePendingSheetExists();
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${config.pendingSheetName}`,
  });
  const values = res.data.values || [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[0]) continue;
    rows.push({
      sheetRowNumber: i + 1,
      id: r[0],
      question: r[1] || '',
      askerAccountId: r[2] || '',
      askerName: r[3] || '',
      roomId: r[4] || '',
      questionMessageId: r[5] || '',
      holderRequestMessageId: r[6] || '',
      status: r[7] || '',
      requestedAt: r[8] || '',
      reminded: r[9] || 'no',
      answer: r[10] || '',
      answeredBy: r[11] || '',
      answeredAt: r[12] || '',
    });
  }
  return rows;
}

async function updatePendingRow(sheetRowNumber, updates) {
  const sheets = await getSheets();
  const colMap = {
    status: 'H',
    reminded: 'J',
    answer: 'K',
    answeredBy: 'L',
    answeredAt: 'M',
  };
  const data = Object.entries(updates).map(([key, value]) => ({
    range: `${config.pendingSheetName}!${colMap[key]}${sheetRowNumber}`,
    values: [[value]],
  }));
  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.sheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// ============================================================
// llm
// ============================================================
let geminiClient = null;
function getGeminiClient() {
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(config.geminiApiKey);
  return geminiClient;
}

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    matched: {
      type: SchemaType.BOOLEAN,
      description: 'Q&A表の中に、質問に十分な確度で答えられる項目があるか',
    },
    rowNumber: {
      type: SchemaType.INTEGER,
      description: 'matched=true の場合、根拠にした表の行番号（スプレッドシートの実際の行番号）',
    },
    answer: {
      type: SchemaType.STRING,
      description: 'matched=true の場合、表の内容に基づいた回答文（お客様にそのまま送れる丁寧な日本語）',
    },
    confidence: {
      type: SchemaType.NUMBER,
      description: '0〜1の確信度',
    },
  },
  required: ['matched', 'confidence'],
};

const SYSTEM_INSTRUCTION = `あなたは不動産会社の顧客対応チャット(Chatwork)に常駐するQ&Aボットです。
必ず与えられた「Q&A表」に書かれている内容だけを根拠に回答してください。
表に無い内容を推測したり、一般知識で補ったりすることは絶対にしないでください。
表の中に質問と意味が一致する、または十分に近い項目があれば matched=true とし、
その行番号(rowNumber)を返してください。実際にお客様へ送る回答文は、あなたが書いた
answerではなく表に書かれている内容がそのまま使われるため、answerは簡単な要約で構いません。
表に該当する項目が無い、もしくは自信が持てない場合は matched=false としてください（answerやrowNumberは省略してよい）。
confidenceは0〜1で、0.75未満の場合は原則matched=falseとしてください。`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function matchQuestion(question, faqRows) {
  const model = getGeminiClient().getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: SYSTEM_INSTRUCTION,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  const table = faqRows
    .map((r) => `行${r.rowNumber}\tQ: ${r.question}\tA: ${r.answer}`)
    .join('\n');

  const prompt = `# Q&A表\n${table || '(表は現在空です)'}\n\n# お客様からの質問\n${question}\n\n上記のQ&A表だけを根拠にJSON形式で回答してください。`;

  // Geminiが一時的な混雑(503など)で失敗することがあるため、
  // 短い間隔を空けて最大3回まで試行する。
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`Geminiの応答をJSONとして解釈できませんでした: ${text}`);
      }
      if (parsed.confidence !== undefined && parsed.confidence < 0.75) {
        parsed.matched = false;
      }
      return parsed;
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        console.error(`Gemini呼び出しに失敗しました(${attempt}回目)。再試行します:`, e.message || e);
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastError;
}

// Geminiが一時的に使えない時の保険用の、単純な文字列一致による簡易マッチング。
// AIによる柔軟な判定はできないが、表の質問文とほぼ同じ聞き方をされた場合は
// 自動回答できるようにする（誤答を避けるため、判定は厳しめ＝一致 or 包含関係のみ）。
function normalizeForMatch(text) {
  return (text || '')
    .replace(/[\s　]+/g, '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[？?！!。、,.]/g, '')
    .toLowerCase();
}

function fallbackMatchQuestion(question, faqRows) {
  const normQuestion = normalizeForMatch(question);
  if (!normQuestion) return { matched: false };
  for (const row of faqRows) {
    const normRowQ = normalizeForMatch(row.question);
    if (!normRowQ) continue;
    if (normQuestion === normRowQ || normQuestion.includes(normRowQ) || normRowQ.includes(normQuestion)) {
      return { matched: true, rowNumber: row.rowNumber, answer: row.answer, confidence: 1, fallback: true };
    }
  }
  return { matched: false };
}

// 表の質問文と完全（正規化後）に一致する場合だけ、AIを使わず確実に即答するための判定。
// Geminiの確信度判定に左右されず、「一度登録された質問と同じ聞き方」なら必ず同じ答えが返るようにする。
function exactMatchQuestion(question, faqRows) {
  const normQuestion = normalizeForMatch(question);
  if (!normQuestion) return { matched: false };
  for (const row of faqRows) {
    const normRowQ = normalizeForMatch(row.question);
    if (!normRowQ) continue;
    if (normQuestion === normRowQ) {
      return { matched: true, rowNumber: row.rowNumber, answer: row.answer, confidence: 1, exact: true };
    }
  }
  return { matched: false };
}

// ============================================================
// businessDays
// ============================================================
function isBusinessDay(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  if (holiday_jp.isHoliday(date)) return false;
  return true;
}

function addBusinessDays(date, n) {
  const d = new Date(date);
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (isBusinessDay(d)) remaining--;
  }
  return d;
}

function hasElapsedBusinessDays(requestedAtIso, businessDays) {
  const requestedAt = new Date(requestedAtIso);
  // 土日・祝日もそのまま1日として数える(スキップしない)。例えば金曜に質問が来た場合、
  // 翌営業日の月曜まで待たず、土曜の朝9時以降に催促する。
  const deadline = new Date(requestedAt);
  deadline.setDate(deadline.getDate() + businessDays);
  // 催促は深夜などに送られないよう、最速でも(計算上の日付の)朝9時以降にする。
  // ただし、これは「9時より前には送らない」というブレーキでしかないため、実際に
  // 9時ぴったりに送らせるには、cron-job.org側のチェック間隔も短くする必要がある
  // (チェックが12時間おきのままだと、9時を過ぎた後の次のチェック(昼12時、
  // またそれも失敗すれば翌日0時)まで送信がずれ込む)。
  deadline.setHours(9, 0, 0, 0);
  return new Date() >= deadline;
}

// ============================================================
// qa
// ============================================================
const TEACH_PATTERN = /(?:質問|Q)\s*[:：]\s*([\s\S]+?)\s*(?:回答|A)\s*[:：]\s*([\s\S]+)/i;

let memberNameCache = new Map();
async function resolveMemberName(roomId, accountId) {
  if (memberNameCache.has(accountId)) return memberNameCache.get(accountId);
  const members = await getRoomMembers(roomId);
  memberNameCache = new Map(members.map((m) => [String(m.account_id), m.name]));
  return memberNameCache.get(String(accountId)) || '';
}

async function processIncomingMessages(messages, { log = console.log } = {}) {
  if (!messages || messages.length === 0) return { processed: 0 };
  const me = await getMe();
  const myAccountId = String(me.account_id);
  let processed = 0;

  for (const msg of messages) {
    const roomId = config.chatworkRoomId;
    const body = msg.body || '';
    const senderId = String(msg.account.account_id);
    const messageId = msg.message_id;

    try {
      if (senderId === myAccountId) continue;

      const replyTarget = parseReplyTarget(body);
      if (replyTarget && config.holderAccountIds.includes(senderId)) {
        const handled = await handleHolderReply({ replyTarget, body, senderId, roomId, messageId, log });
        if (handled) {
          processed++;
          continue;
        }
      }

      if (!isMentionToMe(body, myAccountId)) continue;

      const cleanBody = stripChatworkTags(body);

      if (cleanBody.includes(config.teachTriggerWord)) {
        const m = cleanBody.match(TEACH_PATTERN);
        if (m) {
          const [, q, a] = m;
          await appendFaqRow(q.trim(), a.trim());
          await replyToMessage({
            roomId,
            toAccountId: senderId,
            toMessageId: messageId,
            body: `Q&A表に登録しました。\nQ: ${q.trim()}\nA: ${a.trim()}\n次回から同じ質問には自動で回答します。`,
          });
          processed++;
          continue;
        }
      }

      await handleQuestion({ question: cleanBody, senderId, messageId, roomId, log });
      processed++;
    } catch (e) {
      // 1件のメッセージ処理で失敗しても、他のメッセージの処理は続行する。
      // このメッセージは既読になってしまっているため、可能な範囲でお客様に
      // 「担当者確認中」の返信だけでも送っておく（失敗しても致命的にはしない）。
      console.error(`メッセージ処理でエラーが発生しました(message_id=${messageId}):`, e);
      try {
        if (isMentionToMe(body, myAccountId)) {
          await replyToMessage({
            roomId,
            toAccountId: senderId,
            toMessageId: messageId,
            body: `ただいま担当者に確認しております。少々お待ちください。`,
          });
        }
      } catch (e2) {
        console.error('エラー時のフォールバック返信にも失敗しました:', e2);
      }
    }
  }

  return { processed };
}

// 行の先頭についている番号・記号(「1.」「2)」「①」「・」「-」など)を、本文と切り離して取り出す。
// これにより、「1. 質問文」のように番号つきで送られてきても、表に登録されている
// 番号無しの質問文と完全に同じ言い方として一致させられる。また、お客様が元々付けていた
// 番号(①②③…や1.2.3.など)を、後で担当者への確認メッセージに「そのまま」再利用できる。
const LIST_MARKER_RE = /^[\s]*([0-9０-９]{1,3}[.．、)）]|[①-⑳]|[・\-*])[\s]*/;
function splitLeadingListMarker(text) {
  const m = text.match(LIST_MARKER_RE);
  if (!m) return { marker: '', rest: text.trim() };
  return { marker: m[1], rest: text.slice(m[0].length).trim() };
}

// 回答できなかった質問を担当者への確認メッセージに入れるとき、お客様が元々送ってきた
// 番号(①②③…など)があればそれをそのまま貼り付ける。番号が無かった質問はそのまま表示する。
function formatLeftoverQuestions(unmatched) {
  return unmatched.map((c) => (c.marker ? `${c.marker}${c.text}` : c.text)).join('\n');
}

// 「⇒」「→」で始まる行(担当者が書いた回答案・コメント)や、「▼」「■」などで始まる
// 見出し行(「▼〇〇様より」など)は、お客様への質問そのものではないので候補にしない。
function isNonQuestionLine(line) {
  return /^[⇒→▼■●○◆◇]/.test(line);
}

// 文末が「か」「？」「?」(閉じカッコや句読点が続いてもよい)で終わっている場合のみ、
// 質問らしい文として扱う。これにより、挨拶文や締めの一言、見出しなどが
// 誤って「回答できなかった質問」として担当者への確認メッセージに混ざるのを防ぐ。
function looksLikeQuestion(text) {
  // 「〜でしょうか」のような「か」「？」「?」止まりだけでなく、
  // 「〜教えてください」「〜ご教示ください」のような依頼の言い回しも質問として扱う。
  return /(?:[か？?]|ください|下さい)[\s　)）」』"'.。！!]*$/.test(text);
}

// 1通のメッセージに複数の質問が混ざっている場合に備えて、改行や「？」「?」で区切って
// 候補の質問に分割する。見つかった候補は後段でそれぞれ完全一致を試す。
// 各候補は { marker, text } の形で返し、お客様が元々付けていた番号を後段でも使えるようにする。
function splitIntoCandidateQuestions(text) {
  if (!text) return [];
  const seen = new Set();
  const pieces = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (isNonQuestionLine(trimmedLine)) continue;
    // 「？」「?」の直後で区切る(区切り文字自体は手前の断片に残す)ので、
    // 1行に複数の質問が「Aは？Bは？」のように続けて書かれていても分割できる。
    const parts = trimmedLine.split(/(?<=[？?])/);
    for (const part of parts) {
      const { marker, rest } = splitLeadingListMarker(part.trim());
      if (rest.length >= 4 && looksLikeQuestion(rest) && !seen.has(rest)) {
        seen.add(rest);
        pieces.push({ marker, text: rest });
      }
    }
  }
  return pieces;
}

// 分割した候補ごとに、個別に質問した場合と同じ判定(完全一致→Gemini→文字列一致)を行う。
// 1通に質問が多いほどGeminiの呼び出し回数が増え、混雑(503)の影響を受けやすくなる点に注意。
async function matchCandidatesForPartialAnswers(candidates, faqRows) {
  const matched = [];
  const unmatched = [];
  for (const c of candidates) {
    const q = c.text;
    let r = exactMatchQuestion(q, faqRows);
    if (!r.matched) {
      try {
        r = await matchQuestion(q, faqRows);
        // 個別質問の時と同様、実際に送る文面はGemini自身の生成結果ではなく表の内容をそのまま使う。
        if (r.matched && r.rowNumber) {
          const matchedRow = faqRows.find((row) => row.rowNumber === r.rowNumber);
          if (matchedRow) {
            r.answer = matchedRow.answer;
          } else {
            r.matched = false;
          }
        }
      } catch (e) {
        console.error(`候補質問の判定に失敗しました。文字列一致にフォールバックします(候補: ${q}):`, e);
        r = fallbackMatchQuestion(q, faqRows);
      }
    }
    if (r.matched && r.answer) {
      matched.push({ question: q, ...r });
    } else {
      unmatched.push(c);
    }
  }
  return { matched, unmatched };
}

async function escalateToHolder({ question, senderId, messageId, roomId, log, partial = false }) {
  const askerName = await resolveMemberName(roomId, senderId);
  const mentions = config.holderAccountIds.map((id) => mentionTag(id)).join(' ');
  const intro = partial
    ? '質問者からの質問のうち、Q&A表に無い残りの部分についてご確認をお願いします。'
    : '質問者から以下の質問がありました。Q&A表に無い内容のため、ご確認をお願いします。';
  // 元のご質問のメッセージを探しに行かなくても済むよう、このメッセージに「返信」機能で
  // 回答してもらう。その際、本文中で質問者を「To」でメンションしてもらうことで、
  // (引用返信を使わなくても)質問者にも直接通知が届き、Q&A表への登録も自動で行われる。
  const holderMsg = await sendMessage(
    `${mentions}\n${intro}\n` +
      `このメッセージに「返信」機能で回答ください。その際、本文の中で質問者(${askerName || '質問者'}様)を「To」でメンションしてから回答すると、質問者にも直接届き、Q&A表への登録も自動で行います。\n\n` +
      `【質問者】${askerName || senderId}\n【質問】${question}`,
    roomId
  );

  await appendPendingRow({
    question,
    askerAccountId: senderId,
    askerName,
    roomId,
    questionMessageId: messageId,
    holderRequestMessageId: holderMsg.message_id,
  });

  if (!partial) {
    await replyToMessage({
      roomId,
      toAccountId: senderId,
      toMessageId: messageId,
      body: `ただいま担当者に確認しております。少々お待ちください。`,
    });
  }
  log(`ホルダーへエスカレーションしました${partial ? '(一部)' : ''}: ${question}`);
}

async function handleQuestion({ question, senderId, messageId, roomId, log }) {
  if (!question) return;
  const { rows } = await readFaqTable();

  // まず、メッセージ全体で表の質問文と完全に(正規化後)一致するものがあれば、
  // AIの判定を待たず確実に即答する(1つの質問だけのメッセージは、ここでいつも通り即答される)。
  let result = exactMatchQuestion(question, rows);

  if (!result.matched) {
    // メッセージ全体では一致しなかった場合、1通に複数の質問が混ざっている可能性があるので、
    // 改行や「？」で区切った候補ごとに判定し、答えられるものだけ拾う。
    const candidates = splitIntoCandidateQuestions(question);
    if (candidates.length > 1) {
      const { matched, unmatched } = await matchCandidatesForPartialAnswers(candidates, rows);
      if (matched.length > 0) {
        const leftover = formatLeftoverQuestions(unmatched).trim();
        const answerBody = matched
          .map((m) => {
            const note = m.fallback ? '（簡易一致のため、表現が異なる場合があります）\n' : '';
            return `[info]\n【質問】${m.question}\n【回答】${m.answer}\n\n${note}（Q&A表 ${m.rowNumber}行目を参照）\n[/info]`;
          })
          .join('\n');
        const leftoverNote = leftover
          ? '\n\nなお、上記以外のご質問につきましては、ただいま担当者に確認しております。少々お待ちください。'
          : '';
        await replyToMessage({
          roomId,
          toAccountId: senderId,
          toMessageId: messageId,
          body: `ご質問のうち、お答えできる部分をまとめてご案内します。\n\n${answerBody}${leftoverNote}`,
        });
        log(`複数質問のうち${matched.length}件を自動回答しました: ${question}`);

        if (leftover) {
          await escalateToHolder({ question: leftover, senderId, messageId, roomId, log, partial: true });
        }
        return;
      }
    }

    try {
      result = await matchQuestion(question, rows);
      // Geminiは「どの行が一致するか」の判定役であり、実際にお客様へ送る文面は
      // 表に書かれている内容をそのまま使う（Gemini自身に回答文を書かせると、
      // 複数列(C〜F等)の内容が要約されて一部消えたり、[info]枠が失われたりするため）。
      if (result.matched && result.rowNumber) {
        const matchedRow = rows.find((r) => r.rowNumber === result.rowNumber);
        if (matchedRow) {
          result.answer = matchedRow.answer;
        } else {
          result.matched = false;
        }
      }
    } catch (e) {
      // Geminiが一時的に混雑/エラーの場合は、保険として単純な文字列一致で
      // 表の中に(ほぼ)同じ質問がないか探す。それも見つからなければ担当者エスカレーションへ。
      console.error('matchQuestionに失敗しました。文字列一致にフォールバックします:', e);
      result = fallbackMatchQuestion(question, rows);
    }
  }

  if (result.matched && result.answer) {
    const note = result.fallback ? '（簡易一致のため、表現が異なる場合があります）\n' : '';
    await replyToMessage({
      roomId,
      toAccountId: senderId,
      toMessageId: messageId,
      body: `【質問】${question}\n【回答】${result.answer}\n\n${note}（Q&A表 ${result.rowNumber}行目を参照）`,
    });
    log(`即答しました（行${result.rowNumber}）: ${question}`);
    return;
  }

  await escalateToHolder({ question, senderId, messageId, roomId, log });
}

async function handleHolderReply({ replyTarget, body, senderId, roomId, messageId, log }) {
  const pending = await listPendingRows();
  // ホルダーは基本的に、このボットが送った確認メッセージに「返信」する想定(本文中でお客様を
  // 「To」メンションしてもらうことで、お客様にも直接通知が届く)。念のため、元のご質問の
  // メッセージに直接返信した場合でも拾えるようにしておく。
  const target = pending.find(
    (p) =>
      p.status === 'pending' &&
      (String(p.holderRequestMessageId) === String(replyTarget.toMessageId) ||
        String(p.questionMessageId) === String(replyTarget.toMessageId))
  );
  if (!target) return false;

  const answer = stripChatworkTags(body);
  if (!answer) return false;

  const holderName = await resolveMemberName(roomId, senderId);

  // お客様への通知は、ホルダーが返信本文に入れた「To」メンション自体で届く(そのメッセージは
  // そのままチャットワークに残る)。ボット側から改めて返信は送らず、Q&A表への登録のみ行う。
  await appendFaqRow(target.question, answer);

  await updatePendingRow(target.sheetRowNumber, {
    status: 'answered',
    answer,
    answeredBy: holderName || senderId,
    answeredAt: new Date().toISOString(),
  });

  log(`ホルダー回答を反映しFAQに登録しました: ${target.question}`);
  return true;
}

async function runFollowupCheck({ log = console.log } = {}) {
  const pending = await listPendingRows();
  let reminded = 0;
  for (const p of pending) {
    if (p.status !== 'pending') continue;
    if (p.reminded === 'yes') continue;
    if (!hasElapsedBusinessDays(p.requestedAt, config.followupAfterBusinessDays)) continue;

    // 自社サイトの質問チャット発の保留項目は、Chatworkの特定メッセージには紐づかないため、
    // (返信を待つのではなく)既存ルームへの軽い催促通知だけを送る。
    if (p.roomId === 'site-chat') {
      try {
        const mentions = config.holderAccountIds.map((id) => mentionTag(id)).join(' ');
        await sendMessage(`${mentions}\nサイト内に未回答の質問があります。`);
        await updatePendingRow(p.sheetRowNumber, { reminded: 'yes' });
        reminded++;
        log(`サイトチャットの催促を送信しました: ${p.question}`);
      } catch (e) {
        console.error('サイトチャット分の催促送信に失敗しました:', e);
      }
      continue;
    }

    const stillExists = await messageExists(p.questionMessageId, p.roomId || config.chatworkRoomId);
    if (!stillExists) {
      await updatePendingRow(p.sheetRowNumber, { status: 'cancelled' });
      log(`元の質問メッセージが削除されていたため、催促を中止しました: ${p.question}`);
      continue;
    }

    const mentions = config.holderAccountIds.map((id) => mentionTag(id)).join(' ');
    await replyToMessage({
      roomId: p.roomId || config.chatworkRoomId,
      toAccountId: config.holderAccountIds[0],
      toMessageId: p.holderRequestMessageId,
      body: `${mentions}\n【催促】まだご回答いただけていないようです。お手すきの際にご確認をお願いします。\n\n【質問】${p.question}`,
    });
    await updatePendingRow(p.sheetRowNumber, { reminded: 'yes' });
    reminded++;
    log(`催促を送信しました: ${p.question}`);
  }
  return { reminded, checked: pending.length };
}

// ============================================================
// site chat page（自社サイト用・SHP案件専用の自動回答チャット）
// ============================================================
// ChatworkのBotとは別に、自社サイト用にQ&A表を使った自動回答チャットの
// 専用ページを用意する。質問する側は接客担当(/chat, CHAT_PAGE_PASSWORD)、
// 答える側はプロモーター(/promoter, PROMOTER_PAGE_PASSWORD)と、画面とパスワードを
// それぞれ分けている。ページ自体は単純な共通パスワードで保護し、
// Q&A表に答えが無い質問は保留シートに記録したうえで、/promoter の回答管理画面で
// プロモーターに回答してもらう。既存のChatworkルームが別件のやり取りで混み合っている
// ため新しいグループは作らず、見落とし防止の軽い通知だけをそのルームに送る。
// official-shp.com側には、Renderのこのサーバーを呼び出す独立したHTML(iframeではない)を
// 別途アップロードして使う想定。ドメインをまたいで呼び出すため、Cookieではなく
// 「パスワードをブラウザのsessionStorageに保存し、質問のたびにヘッダーで送って毎回
// サーバー側が照合する」方式にしている（Cookie方式だと、他ドメインから呼び出した際に
// ブラウザの第三者Cookieブロックで正しく動かないことがあるため）。
const CHAT_PASSWORD_HEADER = 'x-chat-password';
const PROMOTER_PASSWORD_HEADER = 'x-promoter-password';

function checkChatPassword(req) {
  // パスワードが設定されていない場合は、誰でも使える状態にしておく
  // （設定し忘れでページが一切使えなくなる事故を避けるため）。
  if (!config.chatPagePassword) return true;
  const provided = req.headers[CHAT_PASSWORD_HEADER] || (req.body && req.body.password) || '';
  return provided === config.chatPagePassword;
}

function checkPromoterPassword(req) {
  // パスワードが設定されていない場合は、誰でも使える状態にしておく
  // （設定し忘れでページが一切使えなくなる事故を避けるため）。
  if (!config.promoterPagePassword) return true;
  const provided = req.headers[PROMOTER_PASSWORD_HEADER] || (req.body && req.body.password) || '';
  return provided === config.promoterPagePassword;
}

function buildChatPageHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="data:image/png;base64,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">
<title>SHP 自動回答チャット</title>
<style>
  :root {
    --brand: #0d74bf;
    --brand-dark: #004781;
    --brand-light: #39a0e1;
    --bg: #eef3f9;
    --panel: #ffffff;
    --text: #17202e;
    --muted: #5b6b7f;
    --user-bubble: #0d74bf;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "游ゴシック", "Yu Gothic", "Meiryo", sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  .app { display: flex; flex-direction: column; height: 100vh; }
  .top-bar {
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: #fff;
    padding: 18px 24px;
    text-align: center;
  }
  .top-bar .title { font-size: 17px; font-weight: 700; }
  .top-bar .subtitle { font-size: 12.5px; opacity: 0.85; margin-top: 4px; }
  .top-bar-inner { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .brand-logo { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; }

  .gate-wrap { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .gate-card {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(20,24,40,0.12);
    padding: 32px 28px;
    width: 100%;
    max-width: 360px;
    text-align: center;
  }
  .gate-card h2 { font-size: 16px; margin: 0 0 18px; }
  .gate-card input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid #dfe2ec;
    border-radius: 10px;
    font-size: 14px;
    margin-bottom: 12px;
    font-family: inherit;
  }
  .gate-card button {
    width: 100%;
    padding: 11px 14px;
    border: none;
    border-radius: 10px;
    background: var(--brand);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }
  .gate-error { color: #d1403a; font-size: 12.5px; margin-top: 10px; min-height: 16px; }

  .role-btn {
    width: 100%;
    padding: 13px 14px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
  }
  .role-btn + .role-btn { margin-top: 10px; }
  .gate-card .role-btn-primary { background: var(--brand); color: #fff; border: none; }
  .gate-card .role-btn-secondary { background: #fff; color: var(--brand); border: 1.5px solid var(--brand); }

  .chat-wrap { flex: 1; display: flex; justify-content: center; overflow: hidden; padding: 0 16px; }
  .chat-column { width: 100%; max-width: 640px; display: flex; flex-direction: column; min-height: 0; }
  .chat-body { flex: 1; overflow-y: auto; padding: 22px 4px 16px; display: flex; flex-direction: column; gap: 16px; }
  .history-session {
    background: #fff;
    border: 1px solid #e7e9f0;
    border-radius: 12px;
  }
  .history-session summary {
    padding: 10px 14px;
    font-size: 12.5px;
    color: var(--muted);
    cursor: pointer;
  }
  .history-body {
    padding: 4px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bubble-row { display: flex; }
  .bubble-row.bot { justify-content: flex-start; }
  .bubble-row.user { justify-content: flex-end; }
  .bubble {
    max-width: 78%;
    padding: 12px 16px;
    border-radius: 16px;
    font-size: 14px;
    line-height: 1.7;
    white-space: pre-wrap;
    box-shadow: 0 1px 2px rgba(20,24,40,0.04);
  }
  .bubble.bot { background: var(--panel); color: var(--text); border-bottom-left-radius: 4px; }
  .bubble.user { background: var(--user-bubble); color: #fff; border-bottom-right-radius: 4px; box-shadow: none; }
  .bubble .info-box {
    background: var(--bg);
    border-left: 3px solid var(--brand);
    border-radius: 8px;
    padding: 10px 12px;
    margin: 8px 0;
  }
  .bubble .info-box:first-child { margin-top: 0; }
  .bubble .info-box:last-child { margin-bottom: 0; }
  .bubble .info-title { font-weight: 700; margin: 8px 0 4px; }
  .bubble .info-title:first-child { margin-top: 0; }
  .typing {
    display: inline-flex;
    gap: 4px;
    padding: 13px 16px;
    background: var(--panel);
    border-radius: 16px;
    border-bottom-left-radius: 4px;
    width: fit-content;
    box-shadow: 0 1px 2px rgba(20,24,40,0.04);
  }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: #a7adbd; animation: blink 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

  .input-bar { padding: 14px 4px 22px; }
  .input-inner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #fff;
    border: 1px solid #dfe2ec;
    border-radius: 24px;
    padding: 6px 6px 6px 18px;
    box-shadow: 0 6px 18px rgba(20,24,40,0.06);
  }
  .input-inner input { flex: 1; border: none; outline: none; font-size: 14px; font-family: inherit; padding: 8px 0; background: transparent; }
  .input-inner button {
    width: 40px; height: 40px; border-radius: 50%; border: none;
    background: var(--brand); color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .input-inner button:disabled { opacity: 0.5; cursor: default; }
  .input-inner button svg { width: 17px; height: 17px; fill: #fff; }
  .input-hint { text-align: center; font-size: 11px; color: #b7bcc9; margin-top: 8px; }
</style>
</head>
<body>
<div class="app">
  <div class="top-bar">
    <div class="top-bar-inner">
      <img class="brand-logo" src="data:image/png;base64,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" alt="OSC">
      <div>
        <div class="title">SHP 自動回答チャット</div>
        <div class="subtitle">接客担当専用 ご質問受付</div>
      </div>
    </div>
  </div>

  <div id="roleSelect" class="gate-wrap" style="display:none;">
    <div class="gate-card">
      <h2>どちらでログインしますか？</h2>
      <button class="role-btn role-btn-primary" id="roleAskerBtn">接客担当としてログイン</button>
      <button class="role-btn role-btn-secondary" id="rolePromoterBtn">プロモーターとしてログイン</button>
    </div>
  </div>

  <div id="gate" class="gate-wrap" style="display:none;">
    <div class="gate-card">
      <h2>パスワードを入力してください</h2>
      <input type="password" id="gate-password" placeholder="パスワード" />
      <button id="gate-submit">開く</button>
      <div class="gate-error" id="gate-error"></div>
    </div>
  </div>

  <div id="chatWrap" class="chat-wrap" style="display:none;">
    <div class="chat-column">
      <div class="chat-body" id="chatBody"></div>
      <div class="input-bar">
        <div class="input-inner">
          <input type="text" id="questionInput" placeholder="質問を入力してください" />
          <button id="sendButton">
            <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          </button>
        </div>
        <div class="input-hint">自動回答です。内容が異なる場合は担当者までご確認ください。</div>
      </div>
    </div>
  </div>
</div>

<script>
(function () {
  var STORAGE_KEY = 'shpChatPassword';
  var HISTORY_KEY = 'shpChatHistory';
  var PENDING_KEY = 'shpChatPendingIds';
  var MAX_SESSIONS = 20;
  var POLL_INTERVAL_MS = 20000;
  var passwordRequired = ${config.chatPagePassword ? 'true' : 'false'};

  function qs(id) { return document.getElementById(id); }

  // Q&A表の回答には、チャットワーク用の[info]...[/info]のような装飾タグが
  // そのまま入っていることがある。このサイトのチャットではチャットワークの
  // 記法を解釈できないため、見やすい形(枠で囲む等)に変換してから表示する。
  function formatAnswerHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    var escaped = div.innerHTML;
    escaped = escaped.replace(/\[info\]([\s\S]*?)\[\/info\]/gi, '<div class="info-box">$1</div>');
    escaped = escaped.replace(/\[title\]([\s\S]*?)\[\/title\]/gi, '<div class="info-title">$1</div>');
    // 上記以外の、チャットワーク独自タグ([qt]や[hr]、[piconname:xxx]など)が
    // 残っていたら、タグ自体だけを取り除いて中身のテキストは残す。
    escaped = escaped.replace(/\[\/?[a-zA-Z][a-zA-Z0-9_:=]*\]/g, '');
    return escaped;
  }

  function getStoredPassword() {
    try { return window.sessionStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function setStoredPassword(pw) {
    try { window.sessionStorage.setItem(STORAGE_KEY, pw); } catch (e) { /* 無視 */ }
  }
  function clearStoredPassword() {
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
  }

  // 過去の会話ログは、この人のブラウザ(localStorage)だけに残す。
  // サーバー側やQ&A表には一切送らない。
  function loadHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveHistory() {
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_SESSIONS))); } catch (e) { /* 無視 */ }
  }

  // 「担当者確認中」になった質問のIDを覚えておき、回答が付いたら自動で表示する。
  function loadPendingIds() {
    try {
      var raw = window.localStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function savePendingIds(ids) {
    try { window.localStorage.setItem(PENDING_KEY, JSON.stringify(ids)); } catch (e) { /* 無視 */ }
  }
  function removePendingId(id) {
    var ids = loadPendingIds().filter(function (x) { return x !== id; });
    savePendingIds(ids);
  }

  var history = loadHistory();
  var currentSession = null;
  var historyRendered = false;

  function ensureCurrentSession() {
    if (!currentSession) {
      currentSession = { startedAt: new Date().toISOString(), messages: [] };
      history.push(currentSession);
    }
  }

  var roleSelectWrap = qs('roleSelect');
  var roleAskerBtn = qs('roleAskerBtn');
  var rolePromoterBtn = qs('rolePromoterBtn');
  var gateWrap = qs('gate');
  var chatWrap = qs('chatWrap');
  var gateSubmit = qs('gate-submit');
  var gatePassword = qs('gate-password');
  var gateError = qs('gate-error');
  var chatBody = qs('chatBody');
  var input = qs('questionInput');
  var sendButton = qs('sendButton');

  function formatWhen(iso) {
    try {
      return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return '以前の会話'; }
  }

  function renderHistory(sessions) {
    for (var i = sessions.length - 1; i >= 0; i--) {
      var s = sessions[i];
      if (!s.messages || !s.messages.length) continue;
      var details = document.createElement('details');
      details.className = 'history-session';
      var summary = document.createElement('summary');
      summary.textContent = formatWhen(s.startedAt) + 'の会話';
      details.appendChild(summary);
      var body = document.createElement('div');
      body.className = 'history-body';
      s.messages.forEach(function (m) {
        var row = document.createElement('div');
        row.className = 'bubble-row ' + m.who;
        var bubble = document.createElement('div');
        bubble.className = 'bubble ' + m.who;
        if (m.who === 'bot') {
          bubble.innerHTML = formatAnswerHtml(m.text);
        } else {
          bubble.textContent = m.text;
        }
        row.appendChild(bubble);
        body.appendChild(row);
      });
      details.appendChild(body);
      chatBody.appendChild(details);
    }
  }

  function showRoleSelect() {
    clearStoredPassword();
    roleSelectWrap.style.display = 'flex';
    gateWrap.style.display = 'none';
    chatWrap.style.display = 'none';
  }

  function showGate(message) {
    clearStoredPassword();
    roleSelectWrap.style.display = 'none';
    gateWrap.style.display = 'flex';
    chatWrap.style.display = 'none';
    gateError.textContent = message || '';
  }

  function showChat() {
    roleSelectWrap.style.display = 'none';
    gateWrap.style.display = 'none';
    chatWrap.style.display = 'flex';
    if (!historyRendered) {
      historyRendered = true;
      renderHistory(history);
      addBubble('こんにちは。SHPに関するご質問を入力してください。', 'bot', false);
    }
    input.focus();
  }

  function submitPassword() {
    var pw = gatePassword.value;
    gateError.textContent = '';
    fetch('/api/ask-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (result.ok && result.data && result.data.ok) {
          setStoredPassword(pw);
          showChat();
        } else {
          gateError.textContent = 'パスワードが違います。';
        }
      })
      .catch(function () {
        gateError.textContent = '通信エラーが発生しました。もう一度お試しください。';
      });
  }

  if (gateSubmit) {
    gateSubmit.addEventListener('click', submitPassword);
    gatePassword.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitPassword();
    });
  }

  if (roleAskerBtn) {
    roleAskerBtn.addEventListener('click', function () { showGate(); });
  }
  if (rolePromoterBtn) {
    rolePromoterBtn.addEventListener('click', function () { window.location.href = '/promoter'; });
  }

  function addBubble(text, who, record) {
    var row = document.createElement('div');
    row.className = 'bubble-row ' + who;
    var bubble = document.createElement('div');
    bubble.className = 'bubble ' + who;
    if (who === 'bot') {
      bubble.innerHTML = formatAnswerHtml(text);
    } else {
      bubble.textContent = text;
    }
    row.appendChild(bubble);
    chatBody.appendChild(row);
    chatBody.scrollTop = chatBody.scrollHeight;
    if (record !== false) {
      ensureCurrentSession();
      currentSession.messages.push({ who: who, text: text });
      saveHistory();
    }
    return bubble;
  }

  function addTyping() {
    var row = document.createElement('div');
    row.className = 'bubble-row bot';
    row.id = 'typingRow';
    var typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    row.appendChild(typing);
    chatBody.appendChild(row);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function removeTyping() {
    var row = qs('typingRow');
    if (row) row.remove();
  }

  // 担当者確認中(pending)になった質問を、定期的に裏側で確認しにいき、
  // 回答が付いていたら自動でチャットに吹き出しとして表示する。
  function pollPendingOnce(id) {
    fetch('/api/ask-status?id=' + encodeURIComponent(id), {
      headers: { 'x-chat-password': getStoredPassword() }
    })
      .then(function (res) {
        if (res.status === 401) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.status === 'answered' && data.answer) {
          addBubble(data.answer, 'bot');
          removePendingId(id);
        } else if (data.status === 'not_found' || data.status === 'cancelled') {
          removePendingId(id);
        }
      })
      .catch(function () { /* 通信エラー時は次回のポーリングに任せる */ });
  }

  function pollAllPending() {
    var ids = loadPendingIds();
    ids.forEach(pollPendingOnce);
  }

  function trackPendingId(id) {
    if (!id) return;
    var ids = loadPendingIds();
    if (ids.indexOf(id) === -1) {
      ids.push(id);
      savePendingIds(ids);
    }
  }

  function send() {
    var question = input.value.trim();
    if (!question) return;
    addBubble(question, 'user');
    input.value = '';
    sendButton.disabled = true;
    addTyping();

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chat-password': getStoredPassword() },
      body: JSON.stringify({ question: question })
    })
      .then(function (res) {
        if (res.status === 401) {
          removeTyping();
          showGate('パスワードが違うようです。もう一度入力してください。');
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        removeTyping();
        var text = (data && data.answer)
          ? data.answer
          : '只今エラーが発生しました。お手数ですが、時間をおいて再度お試しください。';
        addBubble(text, 'bot');
        if (data && data.answered === false && data.pendingId) {
          trackPendingId(data.pendingId);
        }
      })
      .catch(function () {
        removeTyping();
        addBubble('通信エラーが発生しました。お手数ですが、時間をおいて再度お試しください。', 'bot');
      })
      .finally(function () {
        sendButton.disabled = false;
        input.focus();
      });
  }

  // エンターキーでは送信しない(日本語入力の変換確定でエンターを押した際に
  // 誤って送信されてしまうのを防ぐため)。送信は必ずボタンを押してもらう。
  sendButton.addEventListener('click', send);

  if (!passwordRequired || getStoredPassword()) {
    showChat();
  } else {
    showRoleSelect();
  }

  // ページを開いている間、保留中の質問がないか定期的に確認する。
  setInterval(pollAllPending, POLL_INTERVAL_MS);
  pollAllPending();
})();
</script>
</body>
</html>`;
}

// ============================================================
// promoter admin page（プロモーター＝回答者向けの管理画面）
// ============================================================
// 接客担当がチャットで質問して、Q&A表に答えが無かったものを、
// プロモーター（回答者）がここで一覧から選んで回答する「公式LINEの管理画面」的な画面。
function buildPromoterAdminHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="data:image/png;base64,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">
<title>SHP プロモーター用 回答管理</title>
<style>
  :root {
    --brand: #0d74bf;
    --brand-dark: #004781;
    --brand-light: #39a0e1;
    --bg: #eef3f9;
    --panel: #ffffff;
    --text: #17202e;
    --muted: #5b6b7f;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    min-height: 100%;
    font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "游ゴシック", "Yu Gothic", "Meiryo", sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  .top-bar {
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: #fff;
    padding: 18px 24px;
    text-align: center;
  }
  .top-bar .title { font-size: 17px; font-weight: 700; }
  .top-bar .subtitle { font-size: 12.5px; opacity: 0.85; margin-top: 4px; }
  .top-bar-inner { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .brand-logo { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; }

  .gate-wrap { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .gate-card {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(20,24,40,0.12);
    padding: 32px 28px;
    width: 100%;
    max-width: 360px;
    text-align: center;
  }
  .gate-card h2 { font-size: 16px; margin: 0 0 18px; }
  .gate-card input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid #dfe2ec;
    border-radius: 10px;
    font-size: 14px;
    margin-bottom: 12px;
    font-family: inherit;
  }
  .gate-card button {
    width: 100%;
    padding: 11px 14px;
    border: none;
    border-radius: 10px;
    background: var(--brand);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }
  .gate-error { color: #d1403a; font-size: 12.5px; margin-top: 10px; min-height: 16px; }
  .gate-switch { margin-top: 14px; font-size: 12px; }
  .gate-switch a { color: var(--brand); text-decoration: none; font-weight: 600; }

  .admin-wrap { flex: 1; display: none; justify-content: center; padding: 20px 16px 40px; }
  .admin-column { width: 100%; max-width: 680px; }
  .admin-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 4px 2px 14px;
  }
  .admin-toolbar .count { font-size: 13px; color: var(--muted); }
  .admin-toolbar button {
    border: 1px solid #dfe2ec;
    background: #fff;
    border-radius: 10px;
    padding: 7px 14px;
    font-size: 12.5px;
    cursor: pointer;
    color: var(--text);
  }
  .empty-note {
    background: #fff;
    border-radius: 14px;
    padding: 28px 20px;
    text-align: center;
    color: var(--muted);
    font-size: 13.5px;
  }
  .q-card {
    background: var(--panel);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(20,24,40,0.06);
    padding: 16px 18px;
    margin-bottom: 14px;
  }
  .q-card .q-meta { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }
  .q-card .q-text { font-size: 14.5px; line-height: 1.7; white-space: pre-wrap; margin-bottom: 12px; }
  .q-card textarea {
    width: 100%;
    min-height: 80px;
    border: 1px solid #dfe2ec;
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13.5px;
    font-family: inherit;
    resize: vertical;
    margin-bottom: 10px;
  }
  .q-card .q-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .q-card button.answer-btn {
    border: none;
    background: var(--brand);
    color: #fff;
    border-radius: 10px;
    padding: 9px 18px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  .q-card button.answer-btn:disabled { opacity: 0.5; cursor: default; }
  .q-card .q-sent-note { font-size: 12px; color: #2a9d5c; margin-top: 4px; text-align: right; }
  .q-card .q-error-note { font-size: 12px; color: #d1403a; margin-top: 4px; text-align: right; }
</style>
</head>
<body>
<div class="app">
  <div class="top-bar">
    <div class="top-bar-inner">
      <img class="brand-logo" src="data:image/png;base64,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" alt="OSC">
      <div>
        <div class="title">SHP 回答管理</div>
        <div class="subtitle">プロモーター専用（未回答の質問に答える画面）</div>
      </div>
    </div>
  </div>

  <div id="gate" class="gate-wrap" style="display:none;">
    <div class="gate-card">
      <h2>パスワードを入力してください</h2>
      <input type="password" id="gate-password" placeholder="パスワード" />
      <button id="gate-submit">開く</button>
      <div class="gate-error" id="gate-error"></div>
      <div class="gate-switch"><a href="/chat">接客担当の方はこちら</a></div>
    </div>
  </div>

  <div id="adminWrap" class="admin-wrap">
    <div class="admin-column">
      <div class="admin-toolbar">
        <div class="count" id="pendingCount">未回答の質問を確認中...</div>
        <button id="refreshButton">更新</button>
      </div>
      <div id="listBody"></div>
    </div>
  </div>
</div>

<script>
(function () {
  var STORAGE_KEY = 'shpPromoterPassword';
  var REFRESH_INTERVAL_MS = 20000;
  var passwordRequired = ${config.promoterPagePassword ? 'true' : 'false'};

  function qs(id) { return document.getElementById(id); }

  function getStoredPassword() {
    try { return window.sessionStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function setStoredPassword(pw) {
    try { window.sessionStorage.setItem(STORAGE_KEY, pw); } catch (e) { /* 無視 */ }
  }
  function clearStoredPassword() {
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
  }

  var gateWrap = qs('gate');
  var adminWrap = qs('adminWrap');
  var gateSubmit = qs('gate-submit');
  var gatePassword = qs('gate-password');
  var gateError = qs('gate-error');
  var listBody = qs('listBody');
  var pendingCount = qs('pendingCount');
  var refreshButton = qs('refreshButton');
  var refreshTimer = null;

  function showGate(message) {
    clearStoredPassword();
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    gateWrap.style.display = 'flex';
    adminWrap.style.display = 'none';
    gateError.textContent = message || '';
  }

  function showAdmin() {
    gateWrap.style.display = 'none';
    adminWrap.style.display = 'flex';
    loadPending();
    if (!refreshTimer) {
      refreshTimer = setInterval(loadPending, REFRESH_INTERVAL_MS);
    }
  }

  function submitPassword() {
    var pw = gatePassword.value;
    gateError.textContent = '';
    fetch('/api/promoter-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (result.ok && result.data && result.data.ok) {
          setStoredPassword(pw);
          showAdmin();
        } else {
          gateError.textContent = 'パスワードが違います。';
        }
      })
      .catch(function () {
        gateError.textContent = '通信エラーが発生しました。もう一度お試しください。';
      });
  }

  if (gateSubmit) {
    gateSubmit.addEventListener('click', submitPassword);
    gatePassword.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitPassword();
    });
  }

  function formatWhen(iso) {
    try {
      return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function renderList(items) {
    listBody.innerHTML = '';
    pendingCount.textContent = '未回答の質問: ' + items.length + '件';
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = '現在、未回答の質問はありません。';
      listBody.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'q-card';

      var meta = document.createElement('div');
      meta.className = 'q-meta';
      meta.textContent = formatWhen(item.requestedAt) + ' 受付';
      card.appendChild(meta);

      var qText = document.createElement('div');
      qText.className = 'q-text';
      qText.textContent = item.question;
      card.appendChild(qText);

      var textarea = document.createElement('textarea');
      textarea.placeholder = 'ここに回答を入力してください';
      card.appendChild(textarea);

      var actions = document.createElement('div');
      actions.className = 'q-actions';
      var btn = document.createElement('button');
      btn.className = 'answer-btn';
      btn.textContent = '回答する';
      actions.appendChild(btn);
      card.appendChild(actions);

      var note = document.createElement('div');
      card.appendChild(note);

      btn.addEventListener('click', function () {
        var answer = textarea.value.trim();
        if (!answer) {
          note.className = 'q-error-note';
          note.textContent = '回答を入力してください。';
          return;
        }
        btn.disabled = true;
        note.className = '';
        note.textContent = '';
        fetch('/api/promoter-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-promoter-password': getStoredPassword() },
          body: JSON.stringify({ id: item.id, answer: answer })
        })
          .then(function (res) {
            if (res.status === 401) {
              showGate('パスワードが違うようです。もう一度入力してください。');
              return null;
            }
            return res.json();
          })
          .then(function (data) {
            if (!data) return;
            if (data.ok) {
              note.className = 'q-sent-note';
              note.textContent = '回答を送信しました。';
              setTimeout(loadPending, 600);
            } else {
              btn.disabled = false;
              note.className = 'q-error-note';
              note.textContent = 'エラーが発生しました。もう一度お試しください。';
            }
          })
          .catch(function () {
            btn.disabled = false;
            note.className = 'q-error-note';
            note.textContent = '通信エラーが発生しました。もう一度お試しください。';
          });
      });

      listBody.appendChild(card);
    });
  }

  function loadPending() {
    fetch('/api/promoter-pending', {
      headers: { 'x-promoter-password': getStoredPassword() }
    })
      .then(function (res) {
        if (res.status === 401) {
          showGate('パスワードが違うようです。もう一度入力してください。');
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        renderList(data.items || []);
      })
      .catch(function () {
        pendingCount.textContent = '一覧の取得に失敗しました。';
      });
  }

  if (refreshButton) {
    refreshButton.addEventListener('click', loadPending);
  }

  if (!passwordRequired || getStoredPassword()) {
    showAdmin();
  } else {
    showGate();
  }
})();
</script>
</body>
</html>`;
}

// ============================================================
// server
// ============================================================
assertConfig();

const app = express();

function checkSecret(req, res) {
  const provided = req.query.secret || req.headers['x-cron-secret'];
  if (provided !== config.cronSecret) {
    res.status(401).json({ error: 'invalid secret' });
    return false;
  }
  return true;
}

app.get('/poll', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const messages = await getNewMessages();
    const result = await processIncomingMessages(messages);
    res.json({ ok: true, newMessages: messages.length, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/cron/followup', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const result = await runFollowupCheck();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- 接客担当向け自動回答チャットページ（質問する側・SHP案件専用） ----
app.get('/chat', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildChatPageHtml());
});

// ---- プロモーター向け回答管理ページ（答える側） ----
app.get('/promoter', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPromoterAdminHtml());
});

// official-shp.com側に置く独立したHTML(iframeを使わないバージョン)から、
// ドメインをまたいでこれらのAPIを直接呼べるようにするためのCORS設定。
// パスワードはCookieではなくヘッダーで毎回渡す方式なので、認証情報(credentials)は
// やり取りせず、Originは広めに許可しても安全（実際の防御はパスワード自体で行う）。
function allowCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-chat-password, x-promoter-password');
}

['/api/ask-login', '/api/ask', '/api/ask-status', '/api/promoter-login', '/api/promoter-pending', '/api/promoter-answer'].forEach(
  (path) => {
    app.options(path, (req, res) => {
      allowCors(req, res);
      res.sendStatus(204);
    });
  }
);

// ---- 接客担当側（質問する側） ----

app.post('/api/ask-login', express.json(), (req, res) => {
  allowCors(req, res);
  const password = (req.body && req.body.password) || '';
  if (!config.chatPagePassword || password === config.chatPagePassword) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'パスワードが違います' });
});

// Q&A表に答えが無かった分を保留シートに記録し、見落とし防止のため既存のChatwork
// ルームに軽い通知を送る(新しいグループは作らず、返信も期待しない)。
async function createSitePendingAndNotify(question) {
  let pendingId = null;
  try {
    pendingId = await appendPendingRow({
      question,
      askerAccountId: '',
      askerName: '接客担当(自社サイト)',
      roomId: 'site-chat',
      questionMessageId: '',
      holderRequestMessageId: '',
    });
  } catch (e) {
    console.error('保留シートへの記録に失敗しました:', e);
  }
  try {
    const mentions = config.holderAccountIds.map((id) => mentionTag(id)).join(' ');
    await sendMessage(`${mentions}\nサイト内に未回答の質問があります。`);
  } catch (e) {
    console.error('Chatworkへの通知送信に失敗しました:', e);
  }
  return pendingId;
}

app.post('/api/ask', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkChatPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const question = ((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });

    const { rows } = await readFaqTable();
    let result = exactMatchQuestion(question, rows);

    if (result.matched && result.answer) {
      return res.json({ answered: true, answer: result.answer });
    }

    // 1通の質問に複数の内容が混ざっている場合(「○○は?また、△△は?」等)、
    // メッセージ全体では一致しなくても、改行や「？」で区切った候補ごとに判定し、
    // 答えられる部分だけ拾って案内する(Chatworkボットと同じ考え方)。
    const candidates = splitIntoCandidateQuestions(question);
    if (candidates.length > 1) {
      const { matched, unmatched } = await matchCandidatesForPartialAnswers(candidates, rows);
      if (matched.length > 0) {
        const answerBody = matched
          .map((m) => `[info]\n【質問】${m.question}\n【回答】${m.answer}\n[/info]`)
          .join('\n');
        const leftover = formatLeftoverQuestions(unmatched).trim();
        if (!leftover) {
          return res.json({ answered: true, answer: answerBody });
        }
        const pendingId = await createSitePendingAndNotify(leftover);
        return res.json({
          answered: false,
          pendingId,
          answer: `${answerBody}\n\nなお、上記以外のご質問につきましては、ただいま担当者に確認しております。少々お待ちください。`,
        });
      }
    }

    try {
      result = await matchQuestion(question, rows);
      // 実際に表示する回答文は、Chatworkボットと同様に表の内容をそのまま使う。
      if (result.matched && result.rowNumber) {
        const matchedRow = rows.find((r) => r.rowNumber === result.rowNumber);
        if (matchedRow) {
          result.answer = matchedRow.answer;
        } else {
          result.matched = false;
        }
      }
    } catch (e) {
      console.error('サイトチャットの質問判定でエラー:', e);
      result = fallbackMatchQuestion(question, rows);
    }

    if (result.matched && result.answer) {
      return res.json({ answered: true, answer: result.answer });
    }

    // Q&A表に答えが無い場合は、保留シートに記録したうえで、プロモーター用の
    // 回答管理ページ(/promoter)で回答してもらう。
    const pendingId = await createSitePendingAndNotify(question);

    return res.json({
      answered: false,
      pendingId,
      answer:
        '申し訳ございません。この内容については担当者の確認が必要です。\n\n確認でき次第、こちらに回答が届きます。少々お待ちください。',
    });
  } catch (e) {
    console.error('/api/ask エラー:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/ask-status', async (req, res) => {
  allowCors(req, res);
  if (!checkChatPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const id = (req.query.id || '').toString();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const pending = await listPendingRows();
    const target = pending.find((p) => p.id === id);
    if (!target) return res.json({ status: 'not_found' });
    if (target.status === 'answered') {
      return res.json({ status: 'answered', answer: target.answer });
    }
    if (target.status === 'cancelled') {
      return res.json({ status: 'cancelled' });
    }
    return res.json({ status: 'pending' });
  } catch (e) {
    console.error('/api/ask-status エラー:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- プロモーター側（答える側） ----

app.post('/api/promoter-login', express.json(), (req, res) => {
  allowCors(req, res);
  const password = (req.body && req.body.password) || '';
  if (!config.promoterPagePassword || password === config.promoterPagePassword) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'パスワードが違います' });
});

app.get('/api/promoter-pending', async (req, res) => {
  allowCors(req, res);
  if (!checkPromoterPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const pending = await listPendingRows();
    const items = pending
      .filter((p) => p.status === 'pending' && p.roomId === 'site-chat')
      .map((p) => ({ id: p.id, question: p.question, requestedAt: p.requestedAt }))
      .reverse();
    return res.json({ items });
  } catch (e) {
    console.error('/api/promoter-pending エラー:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/promoter-answer', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkPromoterPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const id = ((req.body && req.body.id) || '').toString();
    const answer = ((req.body && req.body.answer) || '').trim();
    if (!id || !answer) return res.status(400).json({ error: 'id and answer are required' });

    const pending = await listPendingRows();
    const target = pending.find((p) => p.id === id && p.roomId === 'site-chat');
    if (!target) return res.status(404).json({ ok: false, error: 'not found' });

    // 次回以降は自動回答できるよう、Q&A表にも登録しておく
    // (チャットワークのホルダー回答時と同じ扱い)。
    await appendFaqRow(target.question, answer);

    await updatePendingRow(target.sheetRowNumber, {
      status: 'answered',
      answer,
      answeredBy: 'プロモーター(サイト管理画面)',
      answeredAt: new Date().toISOString(),
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/promoter-answer エラー:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// 一時的な調査用エンドポイント。原因が分かったら削除してOK。
app.get('/debug', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const me = await getMe();
    const members = await getRoomMembers();
    const messages = (await cwFetch(`/rooms/${config.chatworkRoomId}/messages?force=1`)) || [];
    res.json({
      myAccountId: String(me.account_id),
      myName: me.name,
      configuredRoomId: config.chatworkRoomId,
      configuredHolderAccountIds: config.holderAccountIds,
      roomMembers: members.map((m) => ({
        account_id: String(m.account_id),
        name: m.name,
        role: m.role,
      })),
      recentMessages: messages.slice(-8).map((m) => ({
        message_id: m.message_id,
        account_id: String(m.account.account_id),
        name: m.account.name,
        body: m.body,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 一時的な調査用エンドポイント。Q&A表の中身をそのまま確認するため。原因が分かったら削除してOK。
// ?gid=... または ?name=... を付けると、環境変数を変えずに一時的に別タブを確認できる。
// ?raw=1 を付けると、見出し行の自動判定を一切せず、先頭10行の生データをそのまま返す。
app.get('/debug-sheet', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const overrideGid = req.query.gid;
    const overrideName = req.query.name;

    if (req.query.raw) {
      const title = await resolveFaqSheetTitle(overrideGid, overrideName);
      const sheets = await getSheets();
      const raw = await sheets.spreadsheets.values.get({
        spreadsheetId: config.sheetId,
        range: `${title}`,
      });
      const values = raw.data.values || [];
      // レスポンスを小さく保つため、既定では先頭6行×A〜F列のみ、各セルは30文字までに切り詰める。
      // ?rowFrom=&rowTo=&colFrom=&colTo=&len= で範囲を指定できる。
      const rowFrom = parseInt(req.query.rowFrom || '1', 10);
      const rowTo = parseInt(req.query.rowTo || '6', 10);
      const colFrom = req.query.colFrom ? colLetterToIndex(req.query.colFrom) : 0;
      const colTo = req.query.colTo ? colLetterToIndex(req.query.colTo) : 5;
      const len = parseInt(req.query.len || '30', 10);
      const slice = [];
      for (let i = rowFrom - 1; i < Math.min(rowTo, values.length); i++) {
        const row = values[i] || [];
        const cells = [];
        for (let j = colFrom; j <= colTo; j++) {
          const v = (row[j] || '').toString();
          cells.push({ col: indexToColLetter(j), value: v.slice(0, len) });
        }
        slice.push({ rowNumber: i + 1, cells });
      }
      res.json({ sheetTitle: title, rows: slice });
      return;
    }

    const { title, headerRowIndex, headerRow, blocks, rows } = await readFaqTable(overrideGid, overrideName);
    res.json({
      sheetTitle: title,
      headerRowNumber: headerRowIndex + 1,
      headerRow,
      blocks: blocks.map((b) => ({ questionColumn: b.questionCol, answerColumns: b.answerCols })),
      rowCount: rows.length,
      rows: rows.map((r) => ({
        rowNumber: r.rowNumber,
        questionColumn: r.questionColumn,
        question: r.question,
        questionNormalized: normalizeForMatch(r.question),
        answerPreview: (r.answer || '').slice(0, 60),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 一時的な調査用エンドポイント。スプレッドシート内の全タブ（名前とgid）を一覧表示する。
// 正しいQ&AタブのgidをFAQ_SHEET_GIDに設定するために使用。原因が分かったら削除してOK。
app.get('/debug-sheets', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const tabs = await listAllSheetTabs();
    res.json({ spreadsheetId: config.sheetId, tabs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/', (req, res) => {
  // qa-bot.official-shp.com のようにチャット専用のサブドメインでアクセスされた場合は、
  // トップページ("/")でそのままチャット画面を表示する(「/chat」を付けなくて済むように)。
  const host = (req.hostname || '').toLowerCase();
  if (host.startsWith('qa-bot.')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(buildChatPageHtml());
  }
  res.send('Chatwork Q&A Bot is running.');
});

app.listen(config.port, () => {
  console.log(`Chatwork Q&A Bot listening on port ${config.port}`);
});
