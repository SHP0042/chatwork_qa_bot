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

const SYSTEM_INSTRUCTION = `あなたは、Shopeeなどの海外ECモールで物販を行うショップオーナー向けコミュニティ「海外物販ショップオーナーズくらぶ」の会員サポートチャット(Chatwork)に常駐するQ&Aボットです。
必ず与えられた「Q&A表」に書かれている内容だけを根拠に回答してください。
表に無い内容を推測したり、一般知識で補ったりすることは絶対にしないでください。
表の中に、質問で実際に聞かれている内容と実質的に同じことを答えている項目がある場合のみ matched=true とし、
その行番号(rowNumber)を返してください。実際にお客様へ送る回答文は、あなたが書いた
answerではなく表に書かれている内容がそのまま使われるため、answerは簡単な要約で構いません。
「〜の条件は？」のように聞き方や話題のジャンル（条件・資格など）が似ているだけで、実際に聞かれている対象
（例：出品数の基準、サポート保証の条件、講座延長の条件はそれぞれ別物）が違う場合は、同じ項目とは見なさず
matched=false としてください。表に該当する項目が無い、もしくは自信が持てない場合も matched=false としてください
（answerやrowNumberは省略してよい）。
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
  // 土日・祝日はChatworkへの催促通知を送らない。cron-job.org等から呼ばれても
  // その日は何もせずに終わる(翌営業日のチェックで改めて対象になる)。
  if (!isBusinessDay(new Date())) {
    log('土日・祝日のため、催促チェックをスキップしました。');
    return { reminded: 0, checked: 0, skipped: 'not-business-day' };
  }

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
    overflow: hidden;
    overscroll-behavior: none;
    font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "游ゴシック", "Yu Gothic", "Meiryo", sans-serif;
    background: radial-gradient(ellipse 900px 500px at 50% 0%, #f3f8ff 0%, var(--bg) 70%);
    color: var(--text);
  }
  .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .top-bar {
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: #fff;
    padding: 18px 24px;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0,40,80,0.18);
    position: relative;
    z-index: 1;
  }
  .top-bar .title { font-size: 17px; font-weight: 700; }
  .top-bar .subtitle-row { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 4px; }
  .top-bar .subtitle { font-size: 12.5px; opacity: 0.85; }
  .top-bar-inner { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .brand-logo { width: 48px; height: 48px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #3ddc84;
    box-shadow: 0 0 0 0 rgba(61,220,132,0.6);
    animation: pulse 2s infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(61,220,132,0.55); }
    70% { box-shadow: 0 0 0 6px rgba(61,220,132,0); }
    100% { box-shadow: 0 0 0 0 rgba(61,220,132,0); }
  }

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

  .chat-wrap { flex: 1; display: flex; justify-content: center; overflow: hidden; padding: 20px 16px; min-height: 0; }
  .chat-shell { width: 100%; max-width: 920px; display: flex; gap: 14px; min-height: 0; }
  .room-list-panel {
    width: 260px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    border-radius: 22px;
    box-shadow: 0 24px 60px rgba(10,30,60,0.12), 0 2px 10px rgba(10,30,60,0.05);
    border: 1px solid rgba(10,30,60,0.05);
    overflow: hidden;
  }
  .room-list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 14px 14px 10px;
    border-bottom: 1px solid #eef1f6;
  }
  .room-list-head h3 { margin: 0; font-size: 13.5px; color: var(--text); }
  .new-room-btn {
    border: none;
    background: var(--brand);
    color: #fff;
    font-size: 11.5px;
    font-weight: 700;
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-family: inherit;
    transition: transform 0.1s ease;
    flex-shrink: 0;
  }
  .new-room-btn:hover { transform: scale(1.05); }
  .room-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 6px; }
  .room-list::-webkit-scrollbar { width: 6px; }
  .room-list::-webkit-scrollbar-track { background: transparent; }
  .room-list::-webkit-scrollbar-thumb { background: #d8dfeb; border-radius: 10px; }
  .room-empty { padding: 24px 14px; text-align: center; color: var(--muted); font-size: 12.5px; }
  .room-row {
    position: relative;
    padding: 10px 10px;
    border-radius: 12px;
    cursor: pointer;
    margin-bottom: 2px;
    transition: background 0.12s ease;
  }
  .room-row:hover { background: #f5f8fd; }
  .room-row.active { background: #eaf3fc; }
  .room-row .room-q {
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 46px;
  }
  .room-row.unread .room-q { font-weight: 700; }
  .room-row .room-meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 10.5px; color: var(--muted); }
  .room-unread-dot { width: 7px; height: 7px; border-radius: 50%; background: #3ddc84; flex-shrink: 0; }
  .room-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; padding: 2px 7px; border-radius: 20px; font-weight: 700; flex-shrink: 0; }
  .room-badge.pending { background: #fff2d6; color: #8a6d1f; }
  .room-badge.answered { background: #e4f6ea; color: #1f8a4c; }
  .room-badge.cancelled { background: #f1f1f3; color: #8a8f99; }
  .room-row .room-cancel {
    position: absolute;
    top: 10px;
    right: 8px;
    border: 1px solid #e3c6c6;
    background: #fff;
    color: #c1443d;
    font-size: 10px;
    border-radius: 7px;
    padding: 3px 7px;
    cursor: pointer;
    font-family: inherit;
  }
  .room-row .room-cancel:hover { background: #fdf2f2; }

  .chat-column {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    border-radius: 22px;
    box-shadow: 0 24px 60px rgba(10,30,60,0.12), 0 2px 10px rgba(10,30,60,0.05);
    border: 1px solid rgba(10,30,60,0.05);
    overflow: hidden;
  }
  .room-detail-head {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid #eef1f6;
    background: #fff;
  }
  .room-detail-head .back-btn {
    border: none;
    background: #eef3f9;
    color: var(--brand);
    font-size: 12.5px;
    font-weight: 700;
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }
  .room-detail-head .room-detail-title {
    font-size: 12.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat-body {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 24px 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: linear-gradient(180deg, #fbfcff 0%, #ffffff 160px);
  }
  .chat-body::-webkit-scrollbar { width: 6px; }
  .chat-body::-webkit-scrollbar-track { background: transparent; }
  .chat-body::-webkit-scrollbar-thumb { background: #d8dfeb; border-radius: 10px; }
  .room-placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
    padding: 40px 20px;
  }
  .room-placeholder .ph-emoji { font-size: 28px; }
  .pending-status-card {
    margin-top: 4px;
    max-width: 92%;
    align-self: center;
    width: 100%;
    background: #fff9ec;
    border: 1px solid #f3e3bd;
    border-radius: 14px;
    padding: 10px 14px;
    font-size: 12.5px;
    color: #8a6d1f;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .pending-status-card button {
    flex-shrink: 0;
    border: 1px solid #e3c6c6;
    background: #fff;
    color: #c1443d;
    font-size: 11px;
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
    font-family: inherit;
  }
  .pending-status-card button:hover { background: #fdf2f2; }
  @media (max-width: 720px) {
    .chat-shell { position: relative; }
    .room-list-panel { width: 100%; }
    .chat-shell.mode-list .chat-column { display: none; }
    .chat-shell.mode-detail .room-list-panel { display: none; }
    .room-detail-head { display: flex; }
  }
  .bubble-row { display: flex; align-items: flex-end; gap: 8px; animation: bubbleIn 0.25s ease; }
  .bubble-row.bot { justify-content: flex-start; }
  .bubble-row.user { justify-content: flex-end; }
  @keyframes bubbleIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .bot-avatar { width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; margin-bottom: 2px; }
  .bubble-col { display: flex; flex-direction: column; max-width: 78%; min-width: 0; }
  .bubble-row.user .bubble-col { align-items: flex-end; }
  .bubble-row.bot .bubble-col { align-items: flex-start; }
  .bubble {
    max-width: 100%;
    padding: 12px 16px;
    border-radius: 16px;
    font-size: 14px;
    line-height: 1.7;
    white-space: pre-wrap;
    box-shadow: 0 1px 2px rgba(20,24,40,0.04);
    transition: box-shadow 1.6s ease;
  }
  .bubble.bot { background: var(--panel); color: var(--text); border: 1px solid #eef1f6; border-bottom-left-radius: 4px; }
  .bubble.user { background: var(--user-bubble); color: #fff; border-bottom-right-radius: 4px; box-shadow: none; }
  .bubble-row.bubble-highlight .bubble { box-shadow: 0 0 0 3px rgba(61,220,132,0.45); }
  .bubble-row.bubble-highlight .bot-avatar { box-shadow: 0 0 0 3px rgba(61,220,132,0.45); transition: box-shadow 1.6s ease; }
  .bubble-time { font-size: 10.5px; color: var(--muted); margin: 3px 5px 0; opacity: 0.8; }
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
    border: 1px solid #eef1f6;
    border-radius: 16px;
    border-bottom-left-radius: 4px;
    width: fit-content;
    box-shadow: 0 1px 2px rgba(20,24,40,0.04);
  }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: #a7adbd; animation: blink 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

  .toast-stack {
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    width: 100%;
    padding: 0 16px;
  }
  .toast {
    background: #1f2430;
    color: #fff;
    padding: 10px 16px;
    border-radius: 10px;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    opacity: 0;
    transform: translateY(-6px);
    animation: toastIn 0.25s ease forwards;
    max-width: 100%;
  }
  @keyframes toastIn { to { opacity: 1; transform: translateY(0); } }
  .toast.leaving { animation: toastOut 0.25s ease forwards; }
  @keyframes toastOut { to { opacity: 0; transform: translateY(-6px); } }

  .input-bar { padding: 14px 20px 20px; border-top: 1px solid #eef1f6; background: #fff; }
  .input-inner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #fff;
    border: 1px solid #dfe2ec;
    border-radius: 24px;
    padding: 6px 6px 6px 18px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .input-inner:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(13,116,191,0.12); }
  .input-inner input { flex: 1; border: none; outline: none; font-size: 14px; font-family: inherit; padding: 8px 0; background: transparent; }
  .input-inner button {
    width: 40px; height: 40px; border-radius: 50%; border: none;
    background: var(--brand); color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    transition: transform 0.1s ease;
  }
  .input-inner button:hover:not(:disabled) { transform: scale(1.06); }
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
        <div class="subtitle-row">
          <span class="status-dot"></span>
          <span class="subtitle">接客担当専用 ご質問受付</span>
        </div>
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

  <div class="toast-stack" id="toastStack"></div>

  <div id="chatWrap" class="chat-wrap" style="display:none;">
    <div class="chat-shell mode-list" id="chatShell">
      <div class="room-list-panel">
        <div class="room-list-head">
          <h3>質問一覧</h3>
          <button class="new-room-btn" id="newRoomBtn" type="button">＋ 新しい質問</button>
        </div>
        <div class="room-list" id="roomList"></div>
      </div>
      <div class="chat-column">
        <div class="room-detail-head">
          <button class="back-btn" id="backToListBtn" type="button">← 一覧</button>
          <span class="room-detail-title" id="roomDetailTitle"></span>
        </div>
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
</div>

<script>
(function () {
  var STORAGE_KEY = 'shpChatPassword';
  var ROOMS_KEY = 'shpChatRooms';
  var MAX_ROOMS = 100;
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

  // 質問を送るたびに、1件1件を「部屋」としてこの人のブラウザ(localStorage)
  // だけに記録する(公式LINEのトーク一覧のようなイメージ)。サーバー側やQ&A表
  // には質問本文と回答以外は送らない。新しいものを先頭にして保存し、件数が
  // 多くなりすぎないよう上限を設ける。
  function loadRooms() {
    try {
      var raw = window.localStorage.getItem(ROOMS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveRooms(list) {
    try { window.localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, MAX_ROOMS))); } catch (e) { /* 無視 */ }
  }

  var rooms = loadRooms();
  var activeRoomId = null;

  var roleSelectWrap = qs('roleSelect');
  var roleAskerBtn = qs('roleAskerBtn');
  var rolePromoterBtn = qs('rolePromoterBtn');
  var gateWrap = qs('gate');
  var chatWrap = qs('chatWrap');
  var gateSubmit = qs('gate-submit');
  var gatePassword = qs('gate-password');
  var gateError = qs('gate-error');
  var chatShell = qs('chatShell');
  var roomListEl = qs('roomList');
  var newRoomBtn = qs('newRoomBtn');
  var backToListBtn = qs('backToListBtn');
  var roomDetailTitle = qs('roomDetailTitle');
  var chatBody = qs('chatBody');
  var toastStack = qs('toastStack');
  var input = qs('questionInput');
  var sendButton = qs('sendButton');
  // ヘッダーに表示しているロゴ画像を、ボットの吹き出しの横のアイコンにも使い回す
  // (同じ画像データを埋め込みで二重に持たないようにするため)。
  var logoImg = document.querySelector('.brand-logo');
  var avatarSrc = logoImg ? logoImg.getAttribute('src') : '';

  function formatWhen(iso) {
    try {
      return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return '以前の会話'; }
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function buildBubbleRow(who, text, atIso) {
    var row = document.createElement('div');
    row.className = 'bubble-row ' + who;
    if (who === 'bot' && avatarSrc) {
      var avatar = document.createElement('img');
      avatar.className = 'bot-avatar';
      avatar.src = avatarSrc;
      avatar.alt = '';
      row.appendChild(avatar);
    }
    var col = document.createElement('div');
    col.className = 'bubble-col';
    var bubble = document.createElement('div');
    bubble.className = 'bubble ' + who;
    if (who === 'bot') {
      bubble.innerHTML = formatAnswerHtml(text);
    } else {
      bubble.textContent = text;
    }
    col.appendChild(bubble);
    var timeText = atIso ? formatTime(atIso) : '';
    if (timeText) {
      var time = document.createElement('div');
      time.className = 'bubble-time';
      time.textContent = timeText;
      col.appendChild(time);
    }
    row.appendChild(col);
    return { row: row, bubble: bubble };
  }

  function truncateText(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function updateRoomDetailHead(room) {
    if (roomDetailTitle) roomDetailTitle.textContent = room ? truncateText(room.question, 28) : '新しい質問';
  }

  function enterDetailModeOnMobile() {
    if (!chatShell) return;
    chatShell.classList.remove('mode-list');
    chatShell.classList.add('mode-detail');
  }

  function enterListModeOnMobile() {
    if (!chatShell) return;
    chatShell.classList.remove('mode-detail');
    chatShell.classList.add('mode-list');
  }

  // 質問一覧(左側)を、公式LINEのトーク一覧のように描画する。確認中(⏳)・
  // 回答済み(✓)・取消済みがひと目でわかるようバッジを付け、まだ見ていない
  // 回答があれば太字＋緑の丸で知らせる。確認中のものはその場で取消もできる。
  function renderRoomList() {
    if (!roomListEl) return;
    roomListEl.innerHTML = '';
    if (!rooms.length) {
      var empty = document.createElement('div');
      empty.className = 'room-empty';
      empty.textContent = 'まだ質問がありません。';
      roomListEl.appendChild(empty);
      return;
    }
    rooms.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'room-row' + (r.id === activeRoomId ? ' active' : '') + (r.unread ? ' unread' : '');
      row.addEventListener('click', function () { selectRoom(r.id); });

      var qText = document.createElement('div');
      qText.className = 'room-q';
      qText.textContent = r.question;
      row.appendChild(qText);

      var meta = document.createElement('div');
      meta.className = 'room-meta';
      if (r.unread) {
        var dot = document.createElement('span');
        dot.className = 'room-unread-dot';
        meta.appendChild(dot);
      }
      var badge = document.createElement('span');
      var badgeKind = r.status === 'pending' ? 'pending' : r.status === 'cancelled' ? 'cancelled' : (r.status === 'sending' ? 'pending' : 'answered');
      badge.className = 'room-badge ' + badgeKind;
      badge.textContent = r.status === 'pending' ? '⏳ 確認中'
        : r.status === 'sending' ? '送信中…'
        : r.status === 'cancelled' ? '取消済み'
        : '✓ 回答済み';
      meta.appendChild(badge);
      var timeEl = document.createElement('span');
      timeEl.textContent = formatWhen(r.askedAt);
      meta.appendChild(timeEl);
      row.appendChild(meta);

      if (r.status === 'pending' && r.pendingId) {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'room-cancel';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          deleteRoomPending(r);
        });
        row.appendChild(cancelBtn);
      } else if (r.status !== 'sending') {
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'room-cancel';
        deleteBtn.textContent = '削除';
        deleteBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          deleteRoomLocal(r);
        });
        row.appendChild(deleteBtn);
      }

      roomListEl.appendChild(row);
    });
  }

  // 確認中の質問に対して、チャット欄の下に「確認中です」カード(取消ボタン付き)を出す。
  function showPendingStatusCard(room) {
    if (activeRoomId !== room.id) return;
    var card = document.createElement('div');
    card.className = 'pending-status-card';
    card.id = 'pendingStatusCard';
    var msg = document.createElement('span');
    msg.textContent = '確認中です。回答が届くまでお待ちください。';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '質問を取消';
    btn.addEventListener('click', function () { deleteRoomPending(room); });
    card.appendChild(msg);
    card.appendChild(btn);
    chatBody.appendChild(card);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  // 右側(会話本体)を、選んだ部屋の内容だけで描画し直す。部屋を選び直した時や
  // 取消した時など、「これまでの履歴を読み直す」場面でだけ使うので、吹き出しの
  // 登場アニメーションは付けない(付けると開くたびにパラパラ光って煩わしいため)。
  function renderRoomDetail(room) {
    chatBody.innerHTML = '';
    updateRoomDetailHead(room);
    if (!room) {
      var ph = document.createElement('div');
      ph.className = 'room-placeholder';
      var emoji = document.createElement('div');
      emoji.className = 'ph-emoji';
      emoji.textContent = '👋';
      var text = document.createElement('div');
      text.textContent = 'SHPに関するご質問を入力してください。';
      ph.appendChild(emoji);
      ph.appendChild(text);
      chatBody.appendChild(ph);
      return;
    }
    room.messages.forEach(function (m) {
      var built = buildBubbleRow(m.who, m.text, m.at);
      built.row.style.animation = 'none';
      chatBody.appendChild(built.row);
    });
    chatBody.scrollTop = chatBody.scrollHeight;
    if (room.status === 'pending' && room.pendingId) {
      showPendingStatusCard(room);
    }
  }

  function selectRoom(id) {
    var matches = rooms.filter(function (r) { return r.id === id; });
    if (!matches.length) return;
    var room = matches[0];
    activeRoomId = id;
    if (room.unread) {
      room.unread = false;
      saveRooms(rooms);
    }
    renderRoomDetail(room);
    renderRoomList();
    enterDetailModeOnMobile();
  }

  function startNewRoom() {
    activeRoomId = null;
    renderRoomDetail(null);
    renderRoomList();
    enterDetailModeOnMobile();
    input.focus();
  }

  if (newRoomBtn) newRoomBtn.addEventListener('click', startNewRoom);
  if (backToListBtn) backToListBtn.addEventListener('click', enterListModeOnMobile);

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
    renderRoomList();
    renderRoomDetail(null);
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

  // 1件の部屋(=1回の質問)を新規作成し、一覧の先頭に追加する。
  function createRoom(question) {
    var now = new Date().toISOString();
    var room = {
      id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      question: question,
      messages: [],
      status: 'sending',
      pendingId: null,
      unread: false,
      askedAt: now,
      updatedAt: now
    };
    rooms.unshift(room);
    if (rooms.length > MAX_ROOMS) rooms.length = MAX_ROOMS;
    saveRooms(rooms);
    return room;
  }

  // その部屋にメッセージを1件追加して保存する。いま画面に開いている部屋であれば、
  // その場で吹き出しも追加する(highlightを立てると、新着が一瞬光って知らせる)。
  function addRoomMessage(room, who, text, highlight) {
    var at = new Date().toISOString();
    room.messages.push({ who: who, text: text, at: at });
    room.updatedAt = at;
    saveRooms(rooms);
    if (activeRoomId === room.id) {
      var built = buildBubbleRow(who, text, at);
      if (highlight) {
        built.row.classList.add('bubble-highlight');
        setTimeout(function () { built.row.classList.remove('bubble-highlight'); }, 2200);
      }
      chatBody.appendChild(built.row);
      chatBody.scrollTop = chatBody.scrollHeight;
    }
  }

  // 画面上部に短時間だけ表示する通知(回答到着・取消の成功/失敗など、
  // チャット履歴に残す必要はないが見逃してほしくない出来事を知らせる)。
  function showToast(text) {
    if (!toastStack) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    toastStack.appendChild(el);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 260);
    }, 4000);
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

  // 担当者確認中(pending)の部屋を、定期的に裏側で確認しにいき、回答が付いて
  // いたら自動で反映する。いま開いている部屋なら吹き出しを一瞬ハイライトし、
  // 開いていなければ一覧側を「未読」にする。どちらも画面上部に通知を出す。
  function pollRoomOnce(room) {
    fetch('/api/ask-status?id=' + encodeURIComponent(room.pendingId), {
      headers: { 'x-chat-password': getStoredPassword() }
    })
      .then(function (res) {
        if (res.status === 401) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.status === 'answered' && data.answer) {
          room.status = 'answered';
          room.pendingId = null;
          var isActive = activeRoomId === room.id;
          if (isActive) {
            var card = qs('pendingStatusCard');
            if (card) card.remove();
          } else {
            room.unread = true;
          }
          addRoomMessage(room, 'bot', data.answer, isActive);
          showToast('回答が届きました：' + truncateText(room.question, 26));
          renderRoomList();
        } else if (data.status === 'cancelled' || data.status === 'not_found') {
          room.status = 'cancelled';
          room.pendingId = null;
          saveRooms(rooms);
          renderRoomList();
          if (activeRoomId === room.id) renderRoomDetail(room);
        }
      })
      .catch(function () { /* 通信エラー時は次回のポーリングに任せる */ });
  }

  function pollAllPending() {
    rooms
      .filter(function (r) { return r.status === 'pending' && r.pendingId; })
      .forEach(pollRoomOnce);
  }

  // まだ回答が付いていない質問を取り消す。既に回答済みの場合はサーバー側で
  // 無視されるので(回答は消さない)。成功・失敗のどちらになったかは、必ず
  // 画面上部の通知でわかるようにする。
  function deleteRoomPending(room) {
    fetch('/api/ask-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chat-password': getStoredPassword() },
      body: JSON.stringify({ id: room.pendingId })
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.ok) {
          room.status = 'cancelled';
          room.pendingId = null;
          saveRooms(rooms);
          renderRoomList();
          if (activeRoomId === room.id) renderRoomDetail(room);
          showToast('質問を取り消しました。');
        } else {
          showToast('取り消しに失敗しました。少し時間をおいて、もう一度お試しください。');
        }
      })
      .catch(function () {
        showToast('通信エラーのため取り消せませんでした。少し時間をおいて、もう一度お試しください。');
      });
  }

  // 回答済み・取消済みなど、もう動きのない過去の質問を一覧から消す。
  // サーバー側には何もしない(表示用の履歴をこの端末から消すだけ)ので、
  // 確認中の質問はここでは扱わない(その場合は上の「取消」を使う)。
  function deleteRoomLocal(room) {
    if (!window.confirm('この質問を一覧から削除しますか？(この操作は取り消せません)')) return;
    var idx = rooms.findIndex(function (r) { return r.id === room.id; });
    if (idx === -1) return;
    rooms.splice(idx, 1);
    saveRooms(rooms);
    if (activeRoomId === room.id) {
      activeRoomId = null;
      renderRoomDetail(null);
    }
    renderRoomList();
    showToast('質問を削除しました。');
  }

  function send() {
    var question = input.value.trim();
    if (!question) return;
    input.value = '';
    sendButton.disabled = true;

    // 質問1件につき新しい部屋を1つ作り、その場で開く(公式LINEで新しいトークを
    // 始めるイメージ)。
    var room = createRoom(question);
    activeRoomId = room.id;
    chatBody.innerHTML = '';
    updateRoomDetailHead(room);
    renderRoomList();
    enterDetailModeOnMobile();
    addRoomMessage(room, 'user', question, false);
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
        var stillPending = !!(data && data.answered === false && data.pendingId);
        room.status = stillPending ? 'pending' : 'answered';
        if (stillPending) room.pendingId = data.pendingId;
        addRoomMessage(room, 'bot', text, false);
        if (stillPending) showPendingStatusCard(room);
        renderRoomList();
      })
      .catch(function () {
        removeTyping();
        room.status = 'answered';
        saveRooms(rooms);
        addRoomMessage(room, 'bot', '通信エラーが発生しました。お手数ですが、時間をおいて再度お試しください。', false);
        renderRoomList();
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
    overscroll-behavior-y: none;
    font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "游ゴシック", "Yu Gothic", "Meiryo", sans-serif;
    background: radial-gradient(ellipse 900px 500px at 50% 0%, #f3f8ff 0%, var(--bg) 70%);
    color: var(--text);
  }
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  .top-bar {
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: #fff;
    padding: 18px 24px;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0,40,80,0.18);
    position: relative;
    z-index: 1;
  }
  .top-bar .title { font-size: 17px; font-weight: 700; }
  .top-bar .subtitle-row { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 4px; }
  .top-bar .subtitle { font-size: 12.5px; opacity: 0.85; }
  .top-bar-inner { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .brand-logo { width: 48px; height: 48px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #3ddc84;
    box-shadow: 0 0 0 0 rgba(61,220,132,0.6);
    animation: pulse 2s infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(61,220,132,0.55); }
    70% { box-shadow: 0 0 0 6px rgba(61,220,132,0); }
    100% { box-shadow: 0 0 0 0 rgba(61,220,132,0); }
  }

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
    transition: transform 0.1s ease;
  }
  .gate-card button:hover { transform: scale(1.02); }
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
  .admin-toolbar .count { font-size: 13px; color: var(--muted); font-weight: 600; }
  .admin-toolbar button {
    border: 1px solid #dfe2ec;
    background: #fff;
    border-radius: 10px;
    padding: 7px 14px;
    font-size: 12.5px;
    cursor: pointer;
    color: var(--text);
    transition: transform 0.1s ease, background 0.15s ease, box-shadow 0.15s ease;
  }
  .admin-toolbar button:hover { background: #f5f9ff; transform: scale(1.04); box-shadow: 0 2px 8px rgba(13,116,191,0.12); }
  .empty-note {
    background: #fff;
    border: 1px solid #eef1f6;
    border-radius: 14px;
    padding: 28px 20px;
    text-align: center;
    color: var(--muted);
    font-size: 13.5px;
  }
  .q-card {
    background: var(--panel);
    border: 1px solid #eef1f6;
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(20,24,40,0.06);
    padding: 16px 18px;
    margin-bottom: 14px;
    animation: bubbleIn 0.25s ease;
    transition: box-shadow 0.2s ease, transform 0.2s ease;
  }
  .q-card:hover { box-shadow: 0 10px 28px rgba(10,30,60,0.08); transform: translateY(-1px); }
  @keyframes bubbleIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
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
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .q-card textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(13,116,191,0.12); }
  .q-card .q-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .q-card button.answer-btn {
    border: none;
    background: var(--brand);
    color: #fff;
    border-radius: 10px;
    padding: 9px 18px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.1s ease;
  }
  .q-card button.answer-btn:hover:not(:disabled) { transform: scale(1.05); }
  .q-card button.answer-btn:disabled { opacity: 0.5; cursor: default; }
  .q-card button.delete-btn {
    border: 1px solid #dfe2ec;
    background: #fff;
    color: #d1403a;
    border-radius: 10px;
    padding: 9px 14px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.1s ease, background 0.15s ease;
  }
  .q-card button.delete-btn:hover:not(:disabled) { background: #fdf2f2; transform: scale(1.05); }
  .q-card button.delete-btn:disabled { opacity: 0.5; cursor: default; }
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
        <div class="subtitle-row"><span class="status-dot"></span><span class="subtitle">プロモーター専用（未回答の質問に答える画面）</span></div>
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
      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.textContent = '削除';
      actions.appendChild(deleteBtn);
      var btn = document.createElement('button');
      btn.className = 'answer-btn';
      btn.textContent = '回答する';
      actions.appendChild(btn);
      card.appendChild(actions);

      var note = document.createElement('div');
      card.appendChild(note);

      deleteBtn.addEventListener('click', function () {
        if (!window.confirm('この質問を削除しますか？(この操作は取り消せません)')) return;
        deleteBtn.disabled = true;
        btn.disabled = true;
        note.className = '';
        note.textContent = '';
        fetch('/api/promoter-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-promoter-password': getStoredPassword() },
          body: JSON.stringify({ id: item.id })
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
              loadPending();
            } else if (data.error === 'not_found') {
              note.className = 'q-error-note';
              note.textContent = 'この質問はすでに対応済みか、削除されたようです。一覧を更新します。';
              setTimeout(loadPending, 1200);
            } else {
              deleteBtn.disabled = false;
              btn.disabled = false;
              note.className = 'q-error-note';
              note.textContent = 'サーバー側で問題が発生しました。少し時間をおいてもう一度お試しください。';
            }
          })
          .catch(function () {
            deleteBtn.disabled = false;
            btn.disabled = false;
            note.className = 'q-error-note';
            note.textContent = '通信エラーが発生しました。もう一度お試しください。';
          });
      });

      btn.addEventListener('click', function () {
        var answer = textarea.value.trim();
        if (!answer) {
          note.className = 'q-error-note';
          note.textContent = '回答を入力してください。';
          return;
        }
        btn.disabled = true;
        deleteBtn.disabled = true;
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
            } else if (data.error === 'not_found') {
              note.className = 'q-error-note';
              note.textContent = 'この質問はすでに対応済みか、削除されたようです。一覧を更新します。';
              setTimeout(loadPending, 1200);
            } else {
              btn.disabled = false;
              deleteBtn.disabled = false;
              note.className = 'q-error-note';
              note.textContent = 'サーバー側で問題が発生しました。少し時間をおいてもう一度お試しください。';
            }
          })
          .catch(function () {
            btn.disabled = false;
            deleteBtn.disabled = false;
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

['/api/ask-login', '/api/ask', '/api/ask-status', '/api/ask-delete', '/api/promoter-login', '/api/promoter-pending', '/api/promoter-answer', '/api/promoter-delete'].forEach(
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
  // 土日・祝日はChatworkへの通知を送らない(保留シートへの記録は行うので、
  // 平常営業日になれば次の催促チェックで通知される)。
  if (isBusinessDay(new Date())) {
    try {
      const mentions = config.holderAccountIds.map((id) => mentionTag(id)).join(' ');
      await sendMessage(`${mentions}\nサイト内に未回答の質問があります。`);
    } catch (e) {
      console.error('Chatworkへの通知送信に失敗しました:', e);
    }
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

// 接客担当が、まだ回答の付いていない自分の質問を取り消す(送信ミス等のため)。
// 既に回答が付いている場合は取り消せない(回答はそのまま残す)。
app.post('/api/ask-delete', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkChatPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const id = ((req.body && req.body.id) || '').toString();
    if (!id) return res.status(400).json({ error: 'id is required' });

    const pending = await listPendingRows();
    const target = pending.find((p) => p.id === id && p.roomId === 'site-chat');
    if (!target) return res.status(404).json({ ok: false, error: 'not found' });
    if (target.status !== 'pending') {
      return res.json({ ok: true, alreadyResolved: true });
    }

    await updatePendingRow(target.sheetRowNumber, {
      status: 'cancelled',
      answeredBy: '接客担当(自社サイト・取消)',
      answeredAt: new Date().toISOString(),
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/ask-delete エラー:', e);
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
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });

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
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/promoter-delete', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkPromoterPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const id = ((req.body && req.body.id) || '').toString();
    if (!id) return res.status(400).json({ error: 'id is required' });

    const pending = await listPendingRows();
    const target = pending.find((p) => p.id === id && p.roomId === 'site-chat');
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });

    // Q&A表への登録は行わず、保留シート上のこの質問を「対応不要」として
    // 取り消し扱いにする(接客担当側では、質問者が開いたままの場合に
    // 「cancelled」として扱われ、ポーリングでそっと一覧から消える)。
    await updatePendingRow(target.sheetRowNumber, {
      status: 'cancelled',
      answeredBy: 'プロモーター(サイト管理画面・削除)',
      answeredAt: new Date().toISOString(),
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/promoter-delete エラー:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
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
