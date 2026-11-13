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
  const now = new Date().toISOString();
  const status = entry.status || 'pending';
  const row = [
    id,
    entry.question,
    entry.askerAccountId,
    entry.askerName || '',
    entry.roomId,
    entry.questionMessageId,
    entry.holderRequestMessageId,
    status,
    now,
    'no',
    entry.answer || '',
    entry.answeredBy || '',
    status === 'pending' ? '' : now,
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
  // 土日・祝日であっても関係なく、期限(質問が届いてから既定の日数が経った
  // 翌日の朝9時以降)を過ぎていれば催促を送る。cron-job.org等から土日祝も
  // 休まず呼び出され続けている前提。
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
        await sendMessage(
          `${mentions}\n`
          + `サイト内に未回答の質問が届いています。\n\n`
          + `【質問】\n${p.question}\n\n`
          + `▼回答はこちらから\nhttps://shp-company.site/qa_bot/promoter/`
        );
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
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAB00klEQVR42u29d7wdV3Uv/l17z8xpt6k3y5K7kXvBRS5Xcm8xEHJNyCOFR0ICeYSXAGm/l8jKS0jg5UFI4UEIhIQS4kvAgHEvutiWXMEYN2zJRZZk9dvvOWdm9l6/P6acPfvsIwnbkiVzh4+QfO85c+bM7LVX+67vF5g+po/pY/qYPqaP6WP6mD6mj+lj+pg+po/pY/qYPqaP6WP6mD6mj+lj+pg+po/pY/qYPqaP6WP6mD6mj306aPoWvEH3nQFcv4/3/3pw+kqevnXTBvLmuK+rQAMnDND2Odvzezx3x1wevG5Qv4aFTgM3DIi2cz45yFgNnjagaQM5OI9VEJkxpEag9vTyzz9yht/omSPu2zgy+/lQlHtKQLMJlNK/mwBKACq+YKa4uViWdpW6J9Q/n/lotKfzDtwwIPNrSIxGTz+caQN5Ywzi+gHavmY7Da0citt+f8OAfNe8rQt3q3BhPRJH9ApxTEnwIgUsmlA8JyCaqzREXfPsuuKSFIDSgCBAEhBqhkeEQBADiAR4ZyBJa6btTdY7K0RbygKbx0HP9QHP1zz/5a/tmPsKHIbZf0+/N20w0way/22CV4k1a9aIoRVDKs0g8uPyW85eCk+eUiKcGmo+bTzm40qClmiPKqEnICVBMUMwEMUMpRiaARUzpPEQGImRMJLfEwgggCVBUvJLzyNIAQgiEDO8iBGFeoqIX57ty2e2N/lHJcGPkhSP33np/RsLX4JB/Wv65YoVK/RqWj1tLNMG8hqNYhXEmhX9wvYSA/eed/hkHeeExBfGis9raj4eFVkWnkAz1hAxI44YUMwKrJnBgoCYQVIAYErWfpZ6J3YA5lYSQanBMABKDZLAzMnrWCQ/IGISLIl8n+D5IvlFzJBNXS9J/DRmrCtJ3N1X5XWDyx/YbHuXFSuG9Gqa9izTBrKvB4MGMCAGMahNT3HZXeedUiK6oqn1lY2Yz+SyrCkBRCEjaiqAWYGTpc8gStY/iByZs+YklMr/2/QibFgHAE8krzdLWML4Nyf/xyAwgRkMZgKRENIPBNgjVAighh4T4Ecjwm09TLfdcvnax3gv33n6mDYQI4SCeGpwgMwE++1rzn5LzN7bQsW/GCk+M656FEYaqqkRxawIzEQkCCCdGkO2aKm4zkGpIaQLGkRpSGW8HgBUajw6fY2k5GfmqhVIQizN3OZxDONJnA2z9gQRCZJ+WUJ4BD0Rsy/oR4Hgby/y/e98ecUPfmIm+ssGBnnaq0wbiLEglnEWk/d/t3+2V4uvFcy/0lS4UFWEH4YM1VDQzDETSIIEEqMApws5N4B0gbNlHOYizhZ/tth1upwFFX9nNz7IMCaR/oe2DMw2OsPrMAhaaWYi8kRJoFSS8Oqx8oT4QdXHV2dG4Xe+cunDu7Kc66nBp2hvFblpA3kTG8bgQCukuPaOc08bJ/qNUPMASnJBpBhoaIRKxwAJBkhQsnbNrTULicgylswQBBVDI214F20uYi5aQGZomdEJan0eUTHMyrwMHIZhvz4N1xgAE1gLQZ5fkSh7BBnqV5TG4Oyy+OJ/XXjf43n4NTggfl4NhX4uDcN42L84dMHlE7H67UbMb4sqUjQmFaC0SvNnwZwXk9qOLJcgAmLdWsSwdnTTqDrdcDbCLrJepwyvYoduxfSpZaiCisZovsb0bB6BNaAVMwJPSq8i4DdV3OuJm0Kif7pt5X13/jwbCv28eozzbjvnHZ6g32cpLmgSYWoiBjHHgkgiqaAWQidwerOsharRnkCrzHNwKxwyX0dsLF4qhk46PYdphGboZV5PlsAr03MZhpZ5ITP/EY6wLb8WBkfMKpDC86sSUIxA6zUlD39750Xrvp/1gFZdvwo/L2Vi+nnpcmc73yW3L782BP6o6dFyZiCuKw0wKyYBKoT/xXKrtcMX8ocs1EIxPGLr54Vt3sopmNtfQ1Z4lYdu1mfaIZdR3cp7K2QYrp2rZOcRrcIBR8xagkSpJokY4Ih/MMPHJ269eO3N+Ybzc9B8fDMbCPXf0y+zHsZVd517IQvx53WiixuK0ZiKU29C0txJJbX6EWzs5q5QydzVYYUuAoSYOf99J0Nj63x5zuIwSPM6ZHot2vJawqqWmcYojLKyK/F3FQY0syIQBVUpKgLoZr6lofC/77p07bqsl+JEE0wbyKGRZ/zKvecfuamhVodM71EeIZqMddJ8I2HuupQmumY/wqxGsbWKqMPNNHdpO2nOyrd2HmMbEazPa0u6jWt2FQtgeZ5CeJa+TuylSmbmPqnRKWJQtcsTiDT3efTlMuvV37p43UtZ1evNGHbRm63J178m8RoDNywLhmf2/r4G/fGUL/rqYzETQRMgNdwLhK3wxtz12cgZNLcn5OxY1K4dGR1CODusYqM6JYzFnf08LxdbhtJ2XofxmrmONryLvbo1jG6n4VEESHT1ehSEeiczPq7v8/9haPVQPMADcpBeE1p52kD2J1Yq28GuvPuc85jkp0JfnDU6HiOOtZJEkq1QJLsDmouhjzR6GtlOXfh3+hruEHrZYZN5k4naUpF8IWZvJpfxOXIWovbX2N7D/D52L0ZQu9dgq5lpFwvy1zMr6QlZ7fJQjfS6PtDvf+Oi+x58s3mTN4WBZHHw0Z+5orRk2eifN0B/BElyYjKOBZKqVKeHTx12ebYSXG0YhVl2zXMF0wMYC970KmZSbFawTKviDqVbWA1GNpqLZr6kHH2SQg+kQ5hI7fCVPYaUIsWEMViVqp5XYo48jU9sfHr7X67/8PrmmyU3oUM9pFqFVbSaVuurbzv7jLr0PlcPxJmNsYi1ZhaChL2wXDusq8PNVumU0QJWsVWeLVSULKszQzOgmDArAKHOmnwMX1D+86ZK/rssigtXWOGcMBa+6eXg6K7nYRUDTMXwSRuNyU4FAnJ4teQ1rBgku3p9BKF6yIvx23dcvvYx8CoBrOZDGd9Fb4ZE/OI7ln8oBD4ZSypPTMQxEcms623G6oWkl4v9iSwc8oigwG3d62wxUrqAwUYHm9pxJWZML4ykNxBAzEBDM0qCsLgscGxV4oiqwExfQDFDA9jaZPxkPMbTEwp1DZREMY/QDk/BVnVNOgzf7n0UPIYRQtqYMlieV1t5EwAmZiWrnlfRPNVF/Ie3XLLunw71kOuQNJD+Vf3e0Oqh+G3fPqVvuFb9XFyS72pMKGjWyizbsvWQhQH8s9e0vWjMBNjuFdgwEUIxiXYlwjL9eUMDPgFn9Hi4eLaPpWWBmkf5Z8KAj0SasamhcdfuCPcNx2im74XDKNjwDtn7teNBay7mVHAk+ea1s8OA4ILK5BsBKwghqzWJUqS/PoubHxy89NHRQzXkokPVOC69afmpzRK+FgViWX0sUoxio8/e/WxslKsBZ+7AWZfaXPiA1fcwDMLV6Mv+LdOVVtfAsi6Jd80PcHxNQgNoas7Pb+Yj2X8HAggE4ZlJha9uaeLZSY2KLJaktVXpAhVDSVcH3e612FUAYXkebXtUq/BQgLcwWDHraq8vg1A/6UfqV+6+6sHHD0UjOZQMhAZuSLBAF95y9i9qz/tyHegO63HsCfJc69MOLVw7LndIiLnYAyj2LdAeo3OHWF2lCXvMwDvm+fiFuQF8Apq6WE525MV5KMMMVAQhZMYXNjVx33CMLglE3J4vkZVztHkDq1+Szle15WRwIJVt12uGY9nrfZH8rRhg5rhS87wS81jU5F9fd/W6G3HDgMTAoTN3Ig6ZIabUOC6789yP6JL3X1Ox7lZ1pT1Bnja6yjDi/SzUEK4mm9FxdqFBzOoQ2zu1Faeb5xaWR/LSz/n1RQF+eUEJDKBplZrZgcI1k2tJQF0n8MkPLi7h3D4Pk6r13czya2YEtlFoK5fIfh5biGPXPYBVaCBq/Vsa3xnWewNJXlhXairiHr8ivr3y1nM/iusG1cDggMiJjKY9yGvHUmV4n8tuX/5PYUV+cGQ00pSgbIkdVSl2NALt8q4Lgq6N7rkNFMwTY1i7aofqDmULWwG/ujDAL8wNMBozPIdH2xvkww6lGMBfrK/jxXor3OrU0WfHue2GJln4LtMw2BiLJMsQzRJ3IVSzDUyDPQmu9fiCJqPPDl3xwO/az3baQF6Dcfz6Pf3ll+Lwi5OB/JVwLFKCSGgjZLe9gh0zO4eVOoAGC+hdci9SglH27TA9SEhCoBO6JP7oyDIaqpi/YA9hFfZgJIqBmiQ8Ph7jUy828vzHlZB3qmDZDUXt6OvYzUcYXXwTRm/2XZSFJTPzNsFgDVaVHt+rhPobpw7r//7p6x6or1oFsfogNhI6iMMqAYK+9sbl3ZM13Fgvy4smhsOYiDwzdm+b16bOY69wAAPNjrlrQMluHJq9EZNwwcZUZQvvI0srOLFboN7BQLCnuY4O3fmIgW5J+LuXGnh4NIaXVuc8au/rmHiyHGZPnat35sCWsPoiZOUxEkBsbVCwmpYw7kfagY/LfYEX1NXdW6fw9p++fe34KoY4WEd8xcFsHMtvXN49XOHvNUriovGRKJKCPBf8QVCxmmJWWTR32JWNkCnLK+xZDBOHlSe2bMXh3J4kEwFTCji8InBcV2IcosMYLXcwYN7DTiZTaqCVM708/ndW5AyDJ6TNQXO2xdpgCO3df3PT0RaphDLuFzlg9tk9KuRsRF59JIqaJXHRYTXcdO2Ny7tXEzT44FyL4mCk2smMA2V9U1SW/eMjUSwJvkYLN6WNeezsIQpjsQvDEOBYkIT2foCNt7Jfk52vEEJQa1GZMb5i4NRuD2VBztn0vblx165snqepgSMqEvNKItmpuRhemqGnsPBmGeCS2yyWciPJw6c9hR/G59iVr7ZrN0rRRPAbY1HcLIkLJ2q4afmNy7tB0KtWHXzrURxsOcfq1eCTbzu55lXwPa74F06NRrEQ5MHoXpMV6sTc2uFsPy2tWQhhz3hQkQiB9wDBFVYWblfH2Nrlj6xKqHQmpK1g0AG2gQ5VNTgmDXs8wtHVxEA80epdmL0e00jIgtuTVarNWVK4eG8YHRDKVjUvy1HaSt/p+ZRuPSMm8kZGojgsiQt7u/G9/nv6u1avhsZBZiTi4MJVAcz9cq6ofSusyP7J0TAmQZ7mVoyvDRdvVmk0G+GO8WBiLhoOW1N07DAGu1dA7RttcTiKWj/jPJEGer3k8zt5DDup74SspQ5eRhCwqCSgHGDGQshp7eI26JFtT2OFYWRsMmap155ryYoFytVcouKmAgCeIG98JIqHPdGPMPzuqnv6y9lamDYQe/pvTb9cvRq6/7bwXybL3mWNkTD3HPY8BFmJpjRiXTNeJkoaV8KFXnXsdHaHWFnwCvP3wpE8CyO88YjgETnBfryX0Io7hFfsqHr1eJRjrpxhG7V7CxvmLsmdr7lQxAVjsb+DI9TMczPDEs3NSQjyJkeiuFHxVj4YR/+B1dAHU5/koDCQMz5/hje0cig+/+ZzPxnVvF+fGIkipMZhPmiCg6KT3Imtnz6sUAMhJ5Uflf6dIWhTVo/cqOzd1e5wS2NFMFpJalYx0lwMSwTtuXTI+1BaJLgRtdn7Qzb6PuQoAlghFSwPa4dbRp5QaFRqThqcYfqepgYi3cK2SQPMCbJm7a1wLcsRc5yaJK85FkVjJfn2C2455/OD1w2q/jX98mBYmx4OjlmO6JJbl39gokQfmxoJY4EkrLJj6ULTi1tVGeUgW2tqoCoJi0qEmYFATVIK8WDsDBlbmxq7IkaclkezpN/ELmmrimXG1CJlZIfVRMsWQ6QZEzFjQYkK2CrsYbHTz1CPz14/FnOKAKbCbkeOCpSwRotdE5T2YFWc5n1zA4HZfnIvZ/iE3SFjUmlsDxmbmhqhTnBj7Bgy0RYpBKwCQGo0fn08jrp6/ff333LOi0Mrh/76YMBueW84ZH3lYHzpzWdd1vDxD1N1pcAkSYDym5qWJ9kKYdp2JAI8JHilsiCc0CVxREWgIilN5DlF8xKWVAiRZmwNGY+NxdgRMgJRDDGUPRvCRSBh9to8DDNWuJeWeXeEGsd1SXD62a93A4sBbGloCKIWcBJFT2ZWnApGbpHUZTSnGbgyTj3u0orAsTWJ+SVRMKruCqEkBCIGxmPGExMKz06q3NPaBQdhgSLNDnzOvsLsjY9GcU/N+/ilt5373B0rh775RhsJvdFd8v5bzl7KnnxoSmN21FQsBAntwEeIDqOibPRCwhQte2q3RFkSQg1EzIh1kjTHAJoqyUsIQEkQBAGPjMb40ZiCL4odYEGOWQluj+1tiIYkYCIG3j7Px3sWljAecx7n8z7mI7wPP9NIICcbGxolamcs2eO5OjCeECX3aGZAOLvPw4JAIEyI6vPxXWQzMen7gtT6X6prPDASo6kTSE1sNC+1dTHCggXlBqXBMiCuSKpXoM+989IHfvJGzpN4bxj4cHCA5t88XnoUo99QHs2JJmJFIpkbt7dJouKuzcbOZ1axzur1sKxLoqkZdZU80IAIJDhB1QKoyFay39QJoOuUbg+SgB+OJkbCaK/8FPolrrlwKjbdPAH8dFKhrrjA5O6CtuzrzmWWhCsCeGpCY1NDw3Ndb4fP0Nw+NMYGaXZDAUsqAstnJD2cKKWWJLT6TMytOXcvFfzJvE1VerhnV4xQc1vzlawvlj1Hs5NPCV+Sjn1RixQNDtxxxtmrr8c4ksvgn4skvX9Nvxy8blD9kEc+xV3e2WE6BcgucQwHjMS8uZ5IEsfzZvg4oUtiQnEB4pDxn8fcSqR1yo6e/T5ixuk9Ho7vkoi42DsRVlnTJJ0W1C5HkF1vQMCGKY2nJxVKojOwcU8dde5kJJxc/73DUXHC0DBUze1EDmxV74ThxgQl9/HwikD/TB8CydRjnIanSZWQkrK14SkzI5CUvH6mL3DBTC+Hopgd+DZWR0e1Is33ZHMqVlHZO25b7H8Rq1frNyppF29E3jG0cijuv/msX0LV++DUaBSDiuVcQjs5AYxGVLZSRBoynd4jsbQiMKkYARF80eqyaxRpOLXRFMuKsIKAScU4vUditk+IeM9db7t4oM1KGxXzmDt3Rc4GITq0CvZGFaQ58YLPTiqsHYnzUVyzgpXlZMLCq9mlX7YmLecGhAtneBCU5Ew+GeMC3FrwMWe5DuV9HsppihiLywInd0uEbHGCWeR1zK0IoSADwQATyYnRMI5r3jsvvOns30uonAbkm9pAVq2CGBwY1G8bumBxKOXnGqHSgiHNrq1iq0lGxbFXbXHgzi8JnNTloamzUIbzUoqwxm0zL5JXqKjlXSiNpU/q9tr6DmyWctFOE9Qp3i8J4IdjCuuGY3RJ6thn6BRiuUinE29B+PqWELFu5/UluMNBu49RCFFTQzi3z4dIvYQZzqq8rM2FkrBOP8izLG9SMY6pSszwqG10V5v9FmNDUcZ167wYQ7IxqZQqy0/237b81MHrBtWqA4zZOqAf9tT1AwQCT9Tjz6tAzlKhZqakYmXOc9vNPLagHmT0Lc7slW3IXSKGb5QzpVF3z84fpL9XAHxKkvWmZiwqC8wJil7E3NILhNQWMDLrMShuGboA8LVXQrwwpVF1zG7sS6UkW1CagS5J+PorTTw5oVCWyfVrbp+bB9rHhNkFnUmZVY6sCsz0E7pUjwiSKJdz9yjpHxXYGtNxYHCLuIKNmxEIwnE12SYBYTYm2+4DWeuAQCpm1EElYv2lgScGgqcGB+hANhHFAS3p0qBacdu5H2zW5JXNiShmSggWhAM02MamYYUeioFZflKT1+AWVD194AAg07uclD2plQxmFRYkvRFCC89VFcCSsoTS7RDwLOaG2ZF2VbaoVeqUBIxEjE+9WMe2JqPmJTv0nsKuToLnPR7hv7aFuGVHlBsbWQveSUbBLSiO7Z0y7NSRFVnI3VQa/2QGH6RGIlOjaarklRm0JNLIv5fiZLNZUkn6T5mng/H7vOFrQYTIWpgMyHgqVs2qf9rOTZtWDWYTiQfoODAxHa8ST53wWb78nLOX1kl8c7KpfdK5UGsBAtEWXqV9kNxzUGsm4vCKwKKyQKRb/QdlvE8SpQ86fbiEvBQSpQA/P1XIVHlVKvnvjQ1dAOXBgZdiS8JAOLrYlMbyozHwxITCopLA4RWRh3ZOxDEX4TI1mSzEr2wO8d0dESrpf7N1T8hFTM1FsKJrxqQkCKf0yMJ7sw0nu08m5SkVihWUPztPJK+R6TMLBLArYozE3PaMTSg8jO8AGzlBgABRFGvt++K8U9+z+JZvX3vb5oEbBuRTg0/xm8KDDAw+RSBwE/QPuiR6OE7qq4VKkDHLYVZXTLKALH/ILrpLJqGATN0CG+hdhaQHghQXFeQEbEmNviSSnTxiRlOnyT0BSieNxiCFqdMeOuD21J020MJ2vlGWwLamxt88X8e/bW5ie8ioyOQ7BJRCXtJFGAigIgldHsEj4NGxGH+5vo7v7wjhU1JV0oZXExb8xobgCmofuc3ulWKgKovGJI3v4ucVssQoYzN8TDnEfEGt/2ZjswGhx0t+Jkykr2Pe3+w/Zcaf50GUhAGxIG9M8//rv6ffO1B9PO9AEbxdfOvyd06W6Jqp8UiJlCfX1NcTAGJrIs+GkRd2QEoWXRbvU6otbupleCJx/aFmSNHCFEWMvKSeTd1FbMBOMppRbidosClGYfVkNBVzHWZApSyG2blv2hHh3uEYJ3VJnNojsaichCJlkYSDE4qxO1LYMKXx2HiMDVMaDKArDc9gFSoK98ZB1eMSzMlqGURogSpTgzNDwGxhx8z5v20EcpxwkCZw9vT+Zq8tpRuN3lMPCcUOv2BzMCz/hZyajBV6/TPLE80PDV43+OmULFsdup10BuF60Flnn9VVEvIndUGL41Azc3IPxF66y3CpK6X/DjVwVq/EsTUPKoVyZAtCcZFgLQuvAiIwOIWRJMGWMkq1WbMs0sBtO6O82WjOXLvm0V38uQIdCg8GHirLlQJKFn8Gd6krYEpzXpmrpDSRitsJrNkYFlPonIOYpWlzejDJ5QiXz056H1H62oCS3C4LTzPDK6WbjjKnG7lYEMnOURaE5yYVhnbHqMhis9fMf2Ir7pM2FL91zSx94jJhTHJ08r2XP7IJ14P2J/GD2L+h1YDAaugSiT9UNe/wsKEUJZ642PMwmQnNmQ4qAgVNfBYhwTuZi68iqSB5lpHC+ukCyrxE1geJdZKDZA/Ep8SlUtZlN0OYvQwzmWVYNma/7VFbM2yryuSPJ4ApxRhO4/WIGQEBvR6hItJEWHfO4NnoTdiHuQEUBH+MkK6pW9eb3YsohZbEKQ7NE5RPMiqjmZp46KRqlUUEQS4Nx5jSbp4AMnpS0oLkZ5tVth6MITlSkea4JPsE+38JAg+cMECHpgdJPDL3rzl7CSL55ITichQzSYOqx0zEXUTQ5oKzPUjMwOFlgXP6vNwITCpMk5c2EClRG4q7k0mylu3QEoQtTY01u6M8JHIhigvKtmgnj7ZJHUyDUtYQU7KAMywFQzPlMPyMW8sOlWwmSOEgr0Ynuh/jfmae95q5Qdqr4XTzonyBhMw5MURGDpF5as3tOotZ5avmEdbsirGhrgp0R7wX1hiBIkeAiRtLv6uulQQ8xtlDl619xBZmPSQ8yMBg0vMoh2J1sySqcay1MIzDbBK1DQTZBMoG4M2EeuyOGKFudXwz7+OlfY1s4Ta1g6c3ncA25x0EEiDjzkjnk4imbJowKy8dOnp5JcdYRE2dcPJOpjCYQACzfcJhJYHjagJn9Hp4a6+Ht/ZKnNbj4YQuicUVgdmBSAsRSdhS14mnqesWnEYSwRPWGCy3jwKzo0Wf7dQNnRQQKA8zKceqRWnuobiFvdKp5/CI8nASjpHjhmLsinSezzHcOo2EdsFTbaIUyB5JZm5KEiXmvwaAZQPL+JDyIKlF6yvuOPfUUNDDww1NWqdektpj6IyJXFkyAkQdRGE4m7kAls/wcGRFFIiis/N6wohxrWEmUyQnO2+WoN68PcKEckPUXXSm5n/GnMyCcFplmxkIHFYiLChLLCwR5gQCPR7lCz8QKeLVOG+c5ifZIp2IGeOKsStMyKy3NjVebmoMR5wYPyeVJJNF0iU7zQ55hwRzlZTML53lI+Qk/JQmpREIAq0ihkkALonQ1FwYx808+itNxt27ip64E9lcQbmLHQzzZDNGsp7Z7YlKjMtuueT+O/aXF9mfVSxuKPxZHAjJWikQCbJukra6vNnsh00swHvARD03qXBUVUAawxpZDT9UQEmm8bJIwgdlkVbLNCmKmCFBeG5KYXfMKIkiQ4gnCLHFkZMtxig1ikAQ5gSEE7p8LK0ILK0ILCiJJM9IV49Kr0EbcyVNzhkI8/uRFRlKHmGGRxBGrhQxYzxm7AgZL9Y1fjqh8HxdYVvIaKTX4VFRqoGoHQGdGVJZAFubGttDjVm+yMNNZqBE6X0zyteSkrkbP/2dNAbXZFqyLgvC0xOxU/S0TajHwY5pq/yaQ1fpdXA9ecjXM+PO66/fP16E9ldZ9/zbzj5DC/lgGGqK081Yu26Ea6Ktg16fS7I40sA5fQnMfUIlyS2nvY+kupX8nXkHu6woidKdi9HQwC07IkwpbutKC4e0WsgMZsKCMuHkbg9npqDJXl/k5c+s4mPmKrSPMyB7knWWqYf00nBoLGK82FD48ZjCD8cUtjQ1NDPKkgrlYFjQ8+x5xJwQQFw8ywcj8UzZYmezt0EtwussGW8hhJPMxRcJmHJod4yyKBYIhLUOzLxJG2BFUGvIK6ss2qPAmqGrNSlKTX3FmivX3bY/vMh+8yAU0x/HNSHDhlKUTryZwMM89rT0Jux5BpPj1R7d1JyUHR8bV5gdEGb5Ip9DyCYIQ80FFK8kKtT0Y+bcEB8YjnPj6CTcySkYrywJZ/Z4uHCGj+NrEn1+YmhNzZhMLdHssO9pK2LsnS/LRuyqtLLVSFdYIIATuzyc0u3h7fMYT4wr3D8S4YlxhUnFqKQhnVkgMJHJHgGbmxrPTCqc1C2T3MPI/UTaoPCJjHuciQ5lpV6GL4AdIeORUZV7QTPE01Qk+o4dQqY22lixQ9Erub8cA5DMf0rAbcuefP29CL3eaN3Vq8HX3rX82N0xfjIVaS/t+FInBVjXQjF7COb8gr0Lwdj9ej3CJbN8VCXlHXRJQKwtmHz6+b5Ixm5l2lMZGo6xuaFREg6tkPS9UzoZVDq3z8Mls3wckYZ2DSNp3ld60f1xZPcsC3EYwPN1hTt3RXhkVGE0YlQl8u9sw0dEulOfP8PHcTWBqbRGLNAKD7PGajYX4qX3WFByT3eHGvemG43NjL8n5ngX7Won6ljL6HS1LMRcwed95+J1a19vL/K6epCnThggYFBPxvw/uCL9OFQxgTxwsfTqGv00SdiyDi/ZikcWBaYwOGnHFeOWnRHOm+FhaSWh+5xSnCfBTd3qcGsAghklSXhpSuOH4zFGIs6Nw3xoXqoKRQDO7/Pwtnk+llYkYm4lyHa/4406zNB1Ml3cSyoCv7O4jJdma9y2M8Ka3RGmdFJAiFO5N3uc+f6RCE2dVNOA5D4qJEaXjaB5KWlFgrlKzvXspMKPxuJ86EzZnXxye0bN7WBLsmUbHMgKj4AYrOEL0QjVHwBY+3pXtOh17ZoTuP+7Z8xWfvDTSWAmx8xsqD6Rq89lQzccgMA9VWHY6Lxmrvj4msSRFYFeT+S7XKYaFeukSz0WMzZMJXAO6oCE5XRxHFGR+OUFAU7rSaD1DXVgPAW/Dg8oy9tKItnhn5xQ+ObWEE9OJL0Jn9phIBkYdHFZYFmXxJxA5JtbVnHMsHFNzdjc0PjpZJLkSwfCQFkQoAIK2RHO2jLcpoCqeeK0osZEhJqPUGo+ceiKB9a/nrIK9HpLMV9y+7kfrpfl342PJpgrbTF8u9CmtgItUbsxwOGezdDLDKEy0csFJYEeSaim8XfMyc66M9QYjjn3PjYRBIyKzNVzfFw9J2miTaYiNvQGL/rXYiiV1HPctSvCjdsi7Io0aunNs4sgWY6xsCywsESopfeyoRmTChiJNHaEjNE4KQtLYYw0W7orcEBuTGJtm1nfJZkHCz2dyzswxz0zAi+YUp+46/K1f/x6YrTodSZiEKN9mx6ZkOLUel1p3SHyICvGN3cXbQECNbdjtpB6A8VuXfOs8RcbVDhZPySDU5DVLTVhD5MxsLBMeN9hZZzSLZMQgw+OMOr1yFOIkhBrc0PjK1uaeHBEoeqlcgbszkuUsQlpS3KNbNpSl2x1pwYh3Fry2sadWahlUxeSGLpUEiKIefP8SnD84MqhideL5EG8XqVdEHh8xsZzpwSd0qgrbVDWFmrusBI3diS2jCImy5W0aWPoRptcSxa7uZ+6YpkC7XxqlzgwO7fjMXBWn8SfHVXBCV0SYzEX8p+9zYzv825uDDJpbsE4FBd/zq/xs1x5SkY4NzsgfPSIMn7jsAAiZWmUVsiVJeAVSTm9kp8WAQLDY2R9E3bAYCzAYf7MbONog5qZQ2qWgnABNkQQ9aZSoiYXNbW6MqOyPWigJtvnbCcAaGjxK5EvKGbWbM0h2x9GRqc7e03E7ayAdmPJJLHWduWIW0x+poBlNsOgHNfDaeMrA+29Y56P319aRrdHmFLc5m34VbpebSwWmc6r17xk5qPLS+Ymsj/d6c9qHqEkWlW0zJB4Hwxwb4cJX3n73AB/dGQFs31CXVvFlHxAjQu9qihN8E2oiZ1kFpJra5ShYxWL28VDTfS02avVBmxIEqGhwbub6j0AeMWKFQdJDpK6smvvW969e0z/dErQAh0xE4G0m+C7SO3paMR1UlayQXlmTkNwgxrNeRPl0OATOSAv0RK8ek6ACSN2e635RlYmDlIoSJTG7ztCjZ0RYyTSmFKt68lCnL7USPo8wuwgMZxstqKZ0vHgVYR9rhwoGZoi7I40PruxicfGYvT5lExqWvAVcqlg2fkitQv02IBG2NruxvsltcvH2apeol1GgoUgCoDJbuG95fYr7n359ZB3e81l3gEMiEEMqolJvYIq3oJoIlKSSGrHbLmJhVIw8Fdox97YeoLsgI5ry7gKeB7HDk4odoKTMmHSsf3g4SVcMMPHWNxO9PazJtbZAy+nne7xmLF+IsaTExrrpxR2hDoHWtoCM1EG4chZC4FujzA3EDisLPCWmsSSFMJicleJfayqUQdvMqkYPR7hI0vL+PzLTdw3EqE7Y2JxaMsz9oAe5mIDuK3oYuV+7AhlzB6NdjSZTQm9vDetdBz0+LUgUlcD+NyaFf0Cq4feWAPBYEbbQr8UEjilwi3MLZtJNFtdVdgC9eTuHDMXWU2Y28U5c9dtnUdbMA9tQBskgA8uKeOCGV5SjaF2pVzax+53znqYktxumNJ4OKU13dTQiNN3+ZRgpaqytWwzgrsqqKCqq5GQPgxHCk9OKNy2M8Isn3B0VeKcPg+ndEt0e0llKdKdGUOc8HfD61Zk0hAse8AfHlnG7E2EW3dGCUu+pR+S7+DUIoPIF6/1zG2eARNnx+SW5dYW46JNActWpz2/JiKKFXNT8y8S8LkVK4b00BsaYqXh1X+/b3n3hgn+6ShoASLNlMLa4XCl5i4iHP2ONi5chyvfk1Ktvd136tJ6aTf53QsCnD8j0R1PFm0S92deRu/jTVKcjAALEJ6aULh9Z4THxmM0datQYIpiaovLiuz7Y8btFqAzQ/sGIuEFO6/PwwUzPcz2xT5V3Mw5mZJIoCNbmhqbGoznpxR2pmHfc5PKrZFCxcpgJzXhTsiCwjnSTryrGej6DtxBrlqmAEYIoh4PU7MCddy3Vz606bX2RLzXOjE4iEG1vYlzdSAW8KTSwmDhZ0u+2PYUdoWmDQ7dgZfWxHHZ/RL7MwrCnkai2NTAmb0eapKwZneMQKTJOoCaB8zxBeamSNxYdzaULBTq8Qgb6grf2hri0TGFmBNYSk22EuuY3QNPbFVlFLdD/bN7EOdeKlmEW5saX90S4s5dES6d5ePiFG4zpdi5OLN5lLIkvNLUeHg0wo/GFJ6bUjnHbkbA4JObZysT8DQRBCZ7JXXYsEwtem2EY8ISVMUe9OLJoV9vGBTFWitU/Op4AysBfKV/Rb8Yeg1hlvd6VK+mIr6CqxJArDkhK3EqOsGhQ94msuKQCCOHgpE5S2ISELSRzmVMisZiCTVwXJfESV0SozGnuKUWy+KukLErVNjY0JgXCCypCJRTDmCbCLqcGtB/bg3xve0hGjrh1vKN+NkuFMAStWQrryJqL0zYXE2xbi3QLi+55q9sCXH/SIxfXhDg9B4PdcUFkR+khvxKU+OOnclrd4Q6h8eX05FlsGNq0RqJFdamJtJnpwyOYJtAImNYMZnhlSUXZ0pMkNH7ICvMcsnIyaQnwulI8OUAvjJ3x1x+Y0Os60GXnHfuo6NCnBrWlU6H+dqEWISrKuFwn8LBHoIOxAhtDSeHjLNdRYs5mea7dl6QNsA4LxhoZGQFyS6b7ahVSTiyKrCoJPLmo+aEaGFjXeOLmxKmw5psb5ix1RBjYyrPNQS2pzzB3KFdyrc+JbmIBnDZbB+/NC9AVVKC5k1vzJ27Ity4PcLukFGSRcZ2u1jSYoDJ5CIcYqSOATJnpcoi4bDZ+7XVKYeVX8AxYNVBQkJ7gRBBrF9e2IfjBpc/UH8tTUPxmvQ9CPwLF521RAFv0aFGFl5pR9ikHRJhnapX5o7idLW0Z0tnkwDCgk9UJOHcGR5izUhCVgP7A6Ce/jxDu3opa/kzExpPTah8sXR5hIdGYvzF+jp+OqnQ47XGfgs9GjiHfZzVHzi4dW0WRFMk0zbEbHbcJ+DWHRE+/nwdL9QVZvmEHRHjky808IVNTdQVo+a1P3xtKAaXBGG2L3BsVeCkLokTumR7yMtFwy/ofbC7SKItD29KvrkILmB5FlNEVRu4LmOTFGFTMzxxWH2STkyW6io64CFWFtsNN+TZcUmWdBgrICGiFlYYBQdRgrZJzDqM12a5C3GxaeTCYRVmB+zR0hQy8dYZErN8gboxUhtzsiAyKaYkZ+B8fiSLxTdM6Tx3+f72EF/dEqIkCBWTnyuFfeuUQcWO02kPuu0mBgwOCIZZ7tQOIgczTKtI4IUpjU8838CVc3wM7Y6wpcno8wTilNElA/yFukXevaREOKaWVMYqIvlZRqw3wyc8MBK3mNodhBqZEUhR3Ai01bty5ab2xKHmdvpXtpTHTHb6FvURK1US3shkfD6Ah9esWSM6aAvt/zKvZLogSi6czTIq27MbNtcuFQemlLHLwGJb1NwuVg9qlyJoJxtrVUsaCnhLl8BRVZFT+qgUS+RncgiGKpIJ84hTg6nIxMN84eUG7kqn5QRxHnbJ3OC4Pbnl4gSfthgkCwvDUY3jDk1TATcaV6UI3qZm/MeWECUJ9MjEy+QkcelEZpckHF1LpiF7vGRDCNPCxHiczIDExDimKrC1KbBhSqMk2zFzrgahWao1G4Gw1cK4vaNulndtmlezFVCQw0tfpBKNyvMAfPq15CH0mnTNrwfddc45D4aBPDOsKyUAqR3joeaDsxN0FykcO0Q5C+6V3fQ9Zg5jokmzUOnauQH8dLY8U0/KCAayEdNsmCoRvmdj4SYLZ/2UwprdqS6HRTDgug7uIKsMK5HthB5gq7S9NxKGTtOIZl/FxMYdVZU4rVuiIpNyL0AQxPmmFHOR0AIAbt8Z5cNUiovflYyZnuy7SRTL2nCNLXTYANGhUMF2ady4Tx5Bi0CIquIXqtz7lluvurX5avMQ8Vr6H4+u6J/Jmo4NE14dwZYyk6R2ARxbHMfEVZkEx2yzf6PYF9CGzAB3In5OQyRm4K29iaRYqJPx08w4zOk6cyG0RDEpjfkZ20KNHwwbojVcDAPInKlG+85YyC2oiHWCQ27BvBfC0YW2hUxdhHY65yluVZ/iFH/WP8PHBTO8hPpHcbqpcA6PyQipvXzjSIoYb+31WmyLVrhsG36Wf9qEgNqhHmxPE9q69SbIkbhIgGcpgAkVaUTA4cPe8JGvxRmIV82YCKBRb56gA9EjNbNGgr3S3L4LusZC7do2d4CFZL0MQcWEF5YR5uVfS0pBMWN+WWBxOZlXF2hVpzJmwIyBnXNgI+eilQ3dIk37we64pdrkYAhU3M7rZZIM2NUaZrdmutn8cskk2A1GsoaL2t5j9BgUgD6fcOlsD0sqIp26JPgpvalnYNMy9VxlPLsmM+YEhCUV0SrRWiBCZod3pOKzIQMHBwtoCivXFC7PSEWvlEUUOWGgZiWrUs6Cd1Iq+ycOmIFk/Q/fE8eKEoEBLYxVrq3KhrAoXAhtGtltApM23sf+fSEOtdy0tJCgp3TLAvFZxO3lUWWA5ExibZmSOz8yqjCeonu1IZTDFgK1k0dhixwNFtdTm7oUFRWjTB0NNpSfYDE9UofGa3bdNUm4eKaPGZ7AeJwp0XC6yKmQS+m0KsYGo3tWsDixSxZK8nkxgts3B7LYStjSCREm1Y81JKet88GGGVnPwigCcAxgVOkT8EbB3SONE1Ui8sgFzQdHY7DAkMhuTlsT7pwvCkuyS1Ix1lfc/r4saY40cExVYqafNGeCVP87MJgPExFQbiMuyzyCLwjPTik8O6VQNtw5GeOh5BAaZWNGghx8T5rdap729GTbrDa1z0WYOY+ZY0jjIYc6MY5LZ/moyMQzZoTSMARzTEm6ULcoW+2m5kxf4IiqRFO3k3XbuZK2cgVBDr0SKoJOyU3QUGTOt9ZNNs6b5p+kkgLEyQDwahP1V2UgGdY+kHy8SiAN1EmnwtxNhTkPgCJFpg1MM8UoyRGDmuzvwspIs92yxyMs65KtEqCR3Au0aEHJIQ5D6VDQeMx4dFShRAby2OgXcIe+jI10Nbv+mts5idvgHI55bvNzNNoZCG3tkvxepJ7zwpleStaQeMVQtxRzTSmKrDnoi+J3iLkYQp/UJdEli0NqZiisuV2yzowWzFKvCyHsguMoa0rUDLe1KdqKJCxoaj4KDEqZTmj/GwiDVtNqjRsG5EiEpSpmEIgK8bfxb7tqQjYHL7cLqNhhGKzQhdkBSrQMJWLgxG6Jikx2QkHtc/HCMIwoL5tSIab/0VicMIQY1x0DmOlTq+/SQR3LnHEwxTNhNUGFQ5pZWIBF83tTpy69legr3ZI4OKvXwxxfIOSkp5F3eijBEmcMkzESmH5mEL5obQjmjHhDM2qScFRVItJFj2D2a+wyLjmgQPaGwtyuQUJWBBFzu5cyN2EJUBhqhJoXv3tN/6xXOwb6sxvI9cl1/fqc7XMEYb6KGcyJEKeNLMwIobMYltnNj0QuGbIOwEBbq9xEjubxKJKBo6UVgVAjJ0zLtPQKIV6BYjMJt3RKcbM11HipnohvshGqHF0VeMe8AIvLAspRUiVDaaptAbh4h60kN1N9JaMP1LaAuF2O2vYwghItwUVlgaOqMjf0ZsodnKlahRq5jF2mT2IuzEAUWRaRV8MSNdtMoYocYw62SKeroCCs3oYJp7FBm8qhueLabBiAVoySFH0S4fyko34APMiq69PdRaqZROhBSr5G5B6t1YYMGFlZpPnQiYvwd7PjakIRzPKo5qJqqon5OqlbGvJhRY4mPwXnhdw6ZzZS6qeIXgB4alwVjFIxsLSSSC5MKsYp3QkaWFB78cCMrQu8uOzGoplhp4uSFA6UMsHN9GHeQ4+Ak7tkDqvxyO3NZapSa2KushHfzLuaWoLZ85nhExaXZT4unV8/O2ib7DyN23PWTjAkUzQVVm5qGlhWjBEEIoLSJYFtoV4MAE9hYP8byFODyYdsGIsP50BAWIiAvMMuUOC7co3WmruAsMgCNCclR25XPW0DKJoPOeLEexyZJpBZPV9mBfKc1Dlp/PkWff9Uuss+O6mwualRSmXRYp3gr87t83KmwS6PcFRF5KR0vAccmF2F0Q7Poi2tRjYMWNiGwMWqnRnLZwu4oYClVYFZgcjn8hmUipemTPTcuj/a2NRCLiIcmFuydMrY5UPNOK4mWlAde5DJwqUpC7joFB61ytcC7dU+7hAuFSQfmLlJgIB3OABsX7N9/xtIVuINJHogKUOat7GXaFdB3pAjtt2k5vYEXTlmoF25itm5jxg4piZbwpjU0jBskaIlfQ4vLe9qQxcjq269UM9Ubhky1cE4rUcacJKWrnpgQMDN8MkmK7BDDTN3US4VKiqym4DatdBt+ThzCrIsExI9RouLmJlTwu4kh/KoVcXK2F8yvrBsU/FSyzbZ+DNhzyiV454TUGH0l81GqOVBbTSyXbkzjcGcVBQoKo8RFb2Gfc8IgCcJAfFhB7zMW5Z0BASBmVm7ehMoumPYoVaaRDK3kzeYdXNtj2pSe7XGFP3slknu0TBI3gRa4RQM2sqm0TBMSsCMiiDsCBlbmzpZPGlecnhZYGlZIkwNIzO++SWB+SWRL2JlhX2E9spbW17F1o5phTK2RBkce4+0QqdYJ9c2y0+qVUkzNN0QmBNFKypqDGZ5SSAox5/JVMtRppizViUyhaSkxn1UqrPOhkqUOTxlFlVsdS1zTFhYRsjsbjoLa05eoojIyLr/kWKMKq4dcAMhRrcLkw90Lsu2kYgZUAHRAWckUIw5zU68DWKMkXDRZqVMZWoFpsmoQMuzZMhbabntZyZVYUeSAE7okgl7uXHzs4UwOxD5ws2qYspoHLJjcMxViNAOdK+5abgqVbaKFBuhzOKySBSLcs0/zrXis2vXBry9xc2VfE9ByKtdWf+o1cfiXCw10oy5pQTtq42SrupUoDDyCXLIO5hGT5Y0RhvC11HAoVbITVoDIfMRr7YX8qoNxJOogNsrDG1zDOT+va2T4eqeFxIzy1PAgDmzAUhcWkng3L7hfpWxq0SpkcVpfhIzJ531NEQZjhlbDJb3SCOXQlNW5zYT+5wTUKGBaXacTRVaWDoh5o5ZIKDmYh9BGZOGZHPpOuhcdaqcOydI4DV56JS+IEwVpMhATTc1F0jgTBXeTJvDVNE1UQRxihw+rCwKhRdhPWDqMGeuuch+Am7fAJktsjiT6cQilWODDy19r3/APEhmhZGmhUqz281bA/vCJIHj9plyOKov5kKB1Vcwd2az8dTnJfyxsdFNj41dLAMhhunDz8qblDK4+4KwpaFT1vaW0R5eFjYYrqWqhExGjfLxVlchQhvVKFMoxlbTkmhvfLYtJEdZmR08V366IUTphpDdh0Yq6mMOXpn5nzCeW8RF0GnM7bi6zJCXVIQbJm5AkHSH0j0c/SNY964gutOB08BOfZVmBBIzCcDgwKA+YB4kZq6k8R7ZI5AgNzw5+2Lawvfb5TzFxXmCwqSdhRg133t8OugjiVCRSSk3MLrJCVlBMv/QmxKxZcyFtVSqbWOqdZDtQj0e4ZiqQE0SfEpkmQVRrgkYUGKUARWRxLaik0DRi8DCHuU5jNkEsxgjbVYPcijwZmjdGX5CNN0jk+vzRXL9gaCc0DsQyd8VSSin/y4RIUiFQQNBqGbfN20kVlLWl0Ak7ykJQjVFOM7yk5zHxqjBanbyHqIM7ZgizcLiTJeyjZLJOn8Wlou0my5AM/+cV4kU7k4HZGBqPGZPloq5go3uZC6GAGZFIpsRkNYukp+H2nUr2rrKlmjkzogxPha3Or/G78zSodmNzfojgQAmYsbuSOfxdzYR+OiYKkDhyYjzswcVpopM2jEZJx04Ke3Qgrd7IrqD4IzZB5JUDNdU+n0nFONHY3ESJlHLQE3YiDA8TjYnn30/swJo5o/ZPVBGyCNacxhFD2EgbGNLG9IlqOSiPGKHHEZBBNRaB/bv0mft41VOFb5qA/EttVPlcPfkYOQjC8CorLKliddR7B7ip0L5thW2PDOhnLJp4OLkGVF7HT07j2e57dGIsTNUbWVaG70bCCsMMOc6skWki2A8dgykm+8nB89UQeCygzoXE7AzZGxrqo7MkIVJPwv/BC4KFhVyQov5UFtIhswjKxN3ZRFDkGHgBVI4h0iOKURaADJSey6bo7qp6F09AXqle4IO6MhtlFZFyCH0XpijdqicmuOZnIk1Wu6SrZFZu4egrYVoUvHbyFdN7RAIIYpcv9pGxho0NSUHu4oQ7TX8QoefigltgUTWQhGYBqEdC6lw7dw+iWfvoplnkdTenxLG36ZBKvN3VskY5DYQtnImU1OEOsgTm0ZocVq19Vlsls09zRkxt08fEooURQfUQCQBnCqs2q7OhHuDLFSq6/VUHMW02Uu0Y9Ku0Dik9tFbtheldX2KrXKzTQ5gxbkucgUXY6MwJ+aMhF67WCAdizsPL7g4z2Eq1ZJhgIodKF4bpmGK0mQLWbfOo9C63gKpuLFJZDxcNn0sW7t4ZiTCIIYzL44NDq1CY5CK995e/AU0dAf0s52LZPc+jPnAz4Mw3FggWB1PAffCsAFtZjyureqOWVHKZ07IzcZYqKA5JvvsHUdxe0Jtv842JtdUpIkU0NYoqLZojGzeKG2hA8DtM9raasDCKP2a79EWGlpYXfeCRyMHWyXay8/KgSA2qYiy90VGTueCAtn4LG0NvbE1/WgPX8GqWuagTbQjFtgFZDuQHiS7doEWWzVz0RtICzpCaIdg2JUNV30cNumxC8zH7vfZ5+cOlqAdAb12DDKxdSKXlmJhstLF/N4BQ8R7oNxk17V0CDMcwOo9Com0qX3BPeXIDoIKzXt4JtiDl3YZieVlzLI+d6ChhUUuBze0hw+4B6kQsU+ASk3eLtmaAyzmvDE5SOH4ZxCD4X0Uinm9lZlejWDNvl7r3q6b9+Hc/DNeW8f59X34vE6o29dy77mDCkCnayYLACocs0ic5rhlQfqSM47UB9RASoImUsNgcDuWih3i8C7lqAO1iKePQ+cQDjUpG7+Vl5htBDC1s7pMaZ56V0vUkw8ImjdmfoXJTTlDjti8wJaojVh9+pg+Os2fW2jtwsiApSfinrNhJkloKN7KAFbxKnHgwIqEuiAqdIe1A8psUvfY1QZ6gySRp4+D3DhQrDbaa4YtzJrNAiNhYvcIACIAeGrwKTpgBjLDE5PS7k9QEXFJFgzChCC4hmXeGHdOkCSnV+VBdtiz6QWSPgc40S4upGVmFgLo9cTYAa9ibQ/VhmYSMxE7tMpNQ7A15mDNTegDlIsQKN1RKIVrK9RViFCFqHlVCBLTK/NgMA7LU5ADueyiWnKVeINkqO8lMz3YrwaSoXmV5nHohNGkQCTsmAmxcUQFvMzPYByCMs6RvbloBjPnDO3Zz5qqiYhjKB3DEx56/G4s7joMJ/Qdj/u2r8NYNA6PvML7po8Df2RIAJMlRToY8i2iuNZ/Gy5FaaDk0egB8yDLBgYZABaXvY2vxBpNSlAXykVOYpi56KAWtW+7voBihal4CqGOoFmnuz2nryBoJEAnKQQ88uALPw+dGAyffBzesxiLqgtwXM+xOG3GyTiq+wgsqi5EQzVx8R1X75PxTR8HKLyyxh/Y0ZjNOvBkcYiZoAVmxpTSGw5ciHV98le1xMM65AkS1MUp5y3bfLBUnN2wu7xMbpJi5GU8iUhHGI3GUPOqWNZ7PI7vPQ5La4txXO+xECQQ6RiKFZ4ffwET8SRenNiIV+qvYPPUK6irOogIoQqxsLYAnznzkziq+4i2z3l012PY2dyNbr8LmqdrawdFlr6HaVW2xm5N5WIqQI1IVBRjlie3vNqJwp/ZQFZfD8Zq4MdPNnfIw/zt5FMXh8xka5246DIt8jdyoDdN4xiJRjG7NAu/euQv46pFV+DEvrfkvx+PJhDpCDNLM5IfLCi+/56tP8AHHvyfqHhllEQJm6e24L/d914srC7E7x7321gx73zEOkYgAzw3vh4xx9Me5CDJP+yFLwy+Z5eHIThlJBgCFDV1FFS9LWb0s389CIFX8SqxmlZHF9167ssTHh2pInCoi+QCLrAcqF1zz2Q8b5XWCKPhKK457Ap8bNmHsbiWkFLcvXUI3375e3h69KfY1dyNSMeYGfRhQWUezpn9Vvz3o38NFa+KQPj48fBP0FBN1LwqYigIEmiqEPdtX4dfOvxtkCShoEAgPD36DATEdO5xkJV5tUOXENzuTZRD3k8QGJ6gZqy3rt8WbQWA1a+iFvSqqliZpJVmfh6C+mPNnFHEUAd8ETvEHl0MfJIERsIxfPgtH8SHj/8AAGAsGsOqx/4KN276PgQRAlGCLzxIEtjV3I3tjR24e9u9OKHvLbhs4SWYjCfxvU23oOpVktwk/zyBmcFMHNNzdMrd5UGzxsbJl+EJb3plHiwuxGgPmORwttgOm4hjS6dEE9j3CDWml+6+bl0dzAQiPqDs7lOMx5ncmB4yR2/JPTHXZq0kMRyO4r1HvQcfPv4DiDlGrGP88Q//HDds/DZmBjPQ6/eiJAKI9Ay+8NHld6HX70FDNwEAj+z6IV6afBklWYI2EpyYY9T8ChZVF+bGOByN4OWpzQiED+ZpD3IwuA924PoKXARG4cecvjShTMzM0iPEwJMA0L9mhTxgWKy5K5Jkp1vQej+h0hHkALCRg6/WZKwoziYT6rqBpV2H4yPLPgTFCh55+M6mm/C9zbdiQWU+Yk4SckarhMtgaNZQrLC7uRsA8O2NN0GzLuQUBEKsY8wpzcHs0qz855unXsFIODpd3j0IwyxB7vwEDmVd1zwMAeiSeBwHWh9k8Pok2Zlg/QQ14iYJIVI+5HZUJluyaNY3YaPHMRXV8Z4j3oWqV4VmDQbj+5tuQ0mUoFjt8ZoUKwyHY2BmrNv5YBJeGRUpQYRQh1hUXYhABIh0BAB4afwlNFRzukl48EVZhTkaRgfianQQeWWScVMDGk8ccH0QXJ+s6yvK5U0EvJCSQDEcc9M2lj9h6mvX5FOs0Bt046J5FyZ9C+GjoRp4afLlfQp/CISmamJw47exrbEDgQgsj0BQWuHo7iNz9SQAeGbsuX1ryEwfBxyHVaBZZUv/0aAmcg2ECp+oHPPusUj+BK+S8ufVQ00IPHDDgFy9cjBeees5j5VL4vjJptJEJBjt6qQmW0WMlgxxq2yX9CrmV+ZhYXVhITTS0HstvypW6At68Y0XvwnFCj1+j9vjEHB8z7G5RwGA9ePPQwqZK5NmnqQIuuTX1B8RRKCc8tqebfjZz01IqMsThkSdbwT77/pF2o597dduXz+1abwn/1+Y0jTWi0nGYQ94GZOsWgZCIlJP3n/VfcOvVuH2tWGxUlyLBu6XhF8uEClwi1NWWxJk5JCJToxJo8fvgRQyh4qUZRlHdx2BjZObUJZlxBzvFWLSKVTSrBGIEpZ2HZ58ceEh1CE2Tr6MsiwDIIS6iaZuQmlVKLUFIkDNq7bBV7DXuX0BBlBXDTRVs20xifTcVa+aX6O7s0x5UUJDI9YxmipErCOUZQUVWQYANFUTDd2E0nHh+j2SqHk1CBL7vKCTeF8i5hgT0SQijvL3Zgs8EAGqsgIi2qfzZgYc6Rj1uI6Y47ZzlmUJFVlJ0XJcYEQp8IFxuw5iK7xn9n2Cr+g+TgQ85RCG4gNqICtWrNBDGEKvpPt31zUTSOYJlKV7rS0VJu2oaWeSy5TLSjIEBD5w3G9haPtaNHUTgQj2movsycv0Bj04rLYofyA7GjuxrbEdU6qOhmri8OoinDjjBCzrPT43tFA1cf+OB/Hwrh+iIsuQJPdqJNnDHovGIUjimO4jcWLfCTim56h0K2NEOsbu5i48uvsxPDHyFAiEmldr+34EwlQ8haYKkwUkSphRmoFTaktw8syT8OTI01iz7V74wsOi6kKc1HcCTuxblsNsIh3h8eEncP+OB1BXdXR5XXu9hxm0ZzQcQa/fg7fOPh0n9i3Dgsp8EJJcbjKexIM7H8Fjw48DIFRkeY9G0kJFjGJWaRZOm3kyTppxAuaUZoPBCHWI8XAca3c+iCdGnkIgfJRkAGjdNkFowkrMrnur6ENCxAzJtOa15B94TeMYqds654ZzKqILTzelWKJCrUEtngbt6H1oU+k2Y8sAIeYYfX4vbr34W6j5XQUj+d6mm/G/HvvfmIwn0eP3/MyuXZDAVDyFE3vfghv6vwKAIEngrq1r8Kv3/RbetvhqXLfkF3HhvPM6Qt+/t+lm/PmP/woxK8g9NBUlCYQ6QkM1cOmCi/ErRwzggrnL0RmYp3Dv9nX4h2c+hx8N/xi9fm++gLP7cmLfMpzYtwxHdC3BW3qPw5La4ZhVmgkAeO/a38GW+lZ8+PgP4JIFKxGIwPk5jw8/gU8++Wms3fEg+oK+jkYiSWIinkRFljGw5B1499KBHJ4T6ghN1UR3+nwA4N7ta/FXj38SL0xubCuMmOccj8bRF/Ti3Udch+uWvAOHVZONqq4aYNa5F1Wscccrd+HjP/lb7GjuQkWWcpydkzTOoKpNS8AsPaIu8PASTx3zlUsf3vVaQqzXhK0YuGFADl43qC657dyvNivefxsdDWNJ5JnDLqINH9OuIpUw4EmMhKP4x7P+FlctuhxxirjNgInPja3HX/7k/+C+HWshSaLLq6UVDL1PBjIajeFti67Cp9/6CcQcwyMPPxl+EgDjpBknAgBentoMpRXmlmej6lXTykkMAQFBAt986Ub84Y/+DL1+T8eFMBlPYmZpBlad/Ce4YuGlAIAnhp/EF9Z/GY8NP5HfizNmnoo/WPY/8oXSUA18+OE/xJ1b78mNRJBAPa7jA8f+Jv7bke8qlKcTLxTh2dHncOKMROn4+YkXUY/rmFuegznl2UnvR8cQlFx/QzXw2w98GOt2PoiaV2v7DpIkRqMxnNB7PD5+2vU4sW8ZAOA/XhjEtzZ+By9OvoxQR1haW4w/O/mPcMas00EAdjR2YGDoV7Ej3AWf/MLmkT3Xc2a/FX912p/jiK6lAIAvPPev+P7m2/Dy1GZo1ji2+yj8xal/huN6jgEAPD36DN5z3/sQp/dBp0rEbHFutXGkMSu/5smeSN969+XrrsQqCKx+9WNHr8lA+u/p94ZWDsVX3bn8N+ol+a+7RkIlKNmCNVvSvg5iACpAUQgN1cSS2uH4xgVfRl/Qi5gVPJJQrPKd/c5X1uBLG76Ch3Y+AgFCza8B4EJD0LVwd4fD+IO3/A/8XtqAlCSxrb4dt2y5A/duux/rx5/HeDwBAmFmaQb6556HDx3/AfQFvWkiDDA0rr7rndg4tRklGRQqa8kuOYGje47EP5/99zk85nPPfhGffvofEek4zXWS7WwsHsdbeo7FNy/8CipeDb6QaKgm3nXvr+OZsedQlZW8lzMZT8ITPi6Yew4+feYnUZFlEBGaKsRtW+7A4Es34sXJlzASjkGzRl/Qg6O7j8JvHv1ruHDe+dCsoaHhkYddzV248q53YkrV4RnhoiSJsWgM5805B589++9Q86poqiY+9PBHceuWO1GW5aRBSwKj4RiO7F6C760cREmW4JGHb750Iz72w/8PM4MZiFkZxjGCX1h8FT51xl9DksSOxg787kMfwQM7H0ZFlhGIAJIkdjZ34axZZ+Cb/V9BzBqB8PG5Z7+ATzz5d5gRzIBi1baGyCoDpysr7uoNvNJE9Af3XPXAp7M1+obopA+tGdIAUCe+J5yM6ySSDFtbtJFk8cy6+K40Myqygg3jz+N96z6I3eFwahy6UK25ZMEKfP38L+JzZ38Gb519OsajcTRVuNepQEkyr2Blx0ce/VN89NE/xX07HsCu5m4oVog5xtb6Nnz22X/B/3zkj5IHQ5kak4eju49CqMM8ac5DOFXH4bXD8OVzP5cbx7c2fhd/+ZP/g4qsoC/oRSB8BCKAL3wsKM/DM6PP4l/W/zt84SHUEcqyjD894SNgozLFYPQEPVAcY2t9RxLrp0b2w92P4bce+BAe2vUIhsMRSBIIhI+xaAIP7HgIv3r/+/G1F/4z8SBI8opZpVn4pSVvw0Q8kedZggQm40kc33scPnfO36OWhjt/88T/xc2bb8fc8hzUvGp+j2eVZmLT1BY8MfJ00mBlRv+8CzCnPBthWiCQJDAWjeO8uefi02d8Is9rVv3441i340HMLc9B1TjnnPJsPDu+Ac9PvJiU9cG4eP5F6PK7oKFA1I7wNcP31rwISdmI45klebspWf6GGAhWQ4Mh1ly87iXJeKhUEdAETdyCAEgDBqC5XcebrUS62+/G48NP4l0/+DUMbbsXMg0P0upE3km/ZMEKfO38L+H/nfVpLKouwEg42tFIFCtUZQVHdC1JIS0eGqqBLVOvYFF1Ibq8Gnzh50UCn3wsqMzHgzsexvqx5wsGWvEqbT0ZzRoeSXzqzL/GvMpcKFbY3tiBjz/xt5gR9CZqkgYCgMGIOEaX34Vbt9yBUIcIRADNGmfOPgPHdR9TaF5m33tZ73HpQkue+QsTL6HbS2A2Pvm5QXkk0e13odvvxqef/kdsrW+FIJF/9vI5Z+feg5BcWyAD/N/TP46KLIPB+MH2tfjy81/DvPIcROkMjmm0kY6xtb41//6zSjOxtGsJmroJSRKhjjCrNAOfOP1/p4k14bsv34ybNt+KeZV5hXNm523qJnY0dub3dXFtERZW5iNUUZJEGDmHdBgHCMqvSPI0/eTEiy55Opcsf8MMJCmhiSRW5xtFKoInyZJW4yJnamFmxLGYu/0ubJragvc/8Hv4wIP/E4/s+mEeRyc3iqFYg5lx6cKL8Y0L/g2XLliJsWiszUiyRHdGqQ/zK/Pyn2+c3ISd4a58gZgFXI3kwcXpQs9KrQTKgY1maDIajeG/H/UenDLjpHyBfO2F/8TOxs584bezdnAa+o1gd3MkX2iSJJb1HY9QhYUugWKdG3h2BzeMPw8NndwLa3oyZoWSCLCjsQtrtt2XfyaBsKi6CN1pNUuSxHg4jg8c8z4c13sMIp3A/r+8/qsIRABK77tM/2TPoCzLOaZNk4YgwtzSnDR8TYoiH132YSyszIdmjaYK8aUN/45uvyv97sL4kzyzHq8bi9OcTKdl/pnBTGjE2NMsqTZuahAQQPzd1bRa96/pf81kA6/ZQIbWJC6sh9XNsqFCT6Tf1iKzNt2hSXhNHXb8siyj6lVx+yt34z33/SY+8ODvFwwF4HxnnlWaic+e/WmcNvMUTMSThV4IESFSEQ6rLkTN70Kc9jhenNyIyXgKcg99k5IMMCtNjLNK2HAa+mWLLdQh5pXn4teOeg80M3wKEOsYd265B2ULTWz3bDzhYTwax8bJl9MHnSzydhQAQ5DEkWk1Kbvmn46th2clxa6+0FMjz+T3IguRan4NzJzDb371yHdDs4YvPDwz+lPctXVNWooexmg4ipH0z2g4hl3N3dCsMLc8J8+TFCuMRWPwycOUquP43mPx9sXX5Eb40M6H8eDOR9BUIXaHw/n5RsJRjEZj2NnYBQajy+9ONxRGU4eYUpMgyJaIqUX9as6vSyIZNLXuFvjO6xFevaY+SCvMWq2xCuKWqx9+dvn3z10nK7I/nFKKAGnrPGiHRJvuMDCV7bpZxej2V+7C3VuHcNmClfjIst/D0q4l+Y6bPYQ/PfGjePe97y2EQIkSa4Sju46CACFCDA8SL4y/CKWVc18iECIdYUapD4fVFuY/21Tfglfq2+BLP/cAk9EU3nbY1ZhdmolIR/CFjx/t/gnWT7yASoeyZ7F5GeRlUzIWtv26qqxgSe3w3GtNqTpeqb8CX/h7hMoICAyHxZHs8WgcDdWAJzyMhKN45+HXotvvTipGABZXF+EbF3x5j03XslfG4bXF+WcAwJb6VpRECePxOK5eeDl84efN3ZNmnIAbV3zDCQpNtFoSBERf0Jv/fDKewrbGjrSayTk63NRqNJSQtaxIoUP9o9MeXPfj774O4dXrYyAA+lf0i6HVQ7oS4N+1oP4sumW0Sxe4SKw177nBlxkKg/H9zbfjvu0P4PpT/hRvW3x1biQMxmkzT8EpM07Cj4YfRy0FPGYBSbb7Zgbx7Nj69H3uznWkIyypLUaP352XhTdOvIy6aqBHdOdhmCSBi+b3F3ozj+5+DE3VQM2rQu2hmZh5ysxLmU1S28BnlWbmISKBsK2+DTubu+ELr2OBP1lACgvT92WLbGtjG8ajCXR5XZAkcOG88wuf2dQRjuhamsNxOnmn5ydeSCUwCNsa27G7OQyipGl4/rzlBeOJWeGo7iP2ECgRNCtsGH8hWT1EeHZsPSaiCXgpFk84xm1lSxNdez4JP8Z/rF4N3b+i33u13fPX3UCGVgwpAKh4wXcnp5rDLMUMjpmJQGZFSxg6dRmXaktAR+QQkz0ZyoygD6EO8eGHP4Yevxsr51+YJq1JGLK0awke2vVoa7ExwyMPR3YvzRN0ZmDDxAvp4tJuD8JxvmMrTiShnxr7aT6aSyn4sS/ow4l9y0AgyLQF9PToTyGE3AsxQfL+GUEvev2edIArec8L4y/BTys5SYgYY355fmqsSel7/fjzmIwnCo3FThSFWVWNUwN+cWIjIh1BscLM0sz8+in1Dr/70B/ggZ0Po8uruUPEfEhJGji7xKNGHGNBZQGO6T4qf66hCvGe+34T6yeeR0WU8lCy/ZxJA9f0pL6R75mIDCquJYYQ0qurqZ6K959mhfUNz0FM8OJNK4d2lkncGFQlFFixRXlvkXolniPRksNEPJnAKfbSmok5hi98lGQJn3nms2kjjApzJfYu3et34+iuI/IHtjvcje31HSlK2L3zMjPe0ntcYWd/YfzFPKGkFD4/rzI3n4uXQqQzJpvh72W+JAvjFtcWoySDtM5P2NXcjReyUme6O0c6yrvZmTGsn3ihiBlzJq+MQAY4uqe1WAHgx7sTeEjMMWaVZuZd+aTROYVNU5tR9SqQJOGR1/5HJH+LHHCYYKwyzzuvMjcfWQCAHc0E0lOVezunhDC4ywSJPJTKCEBMUvQWxxqr7i5JJeD73+m/9+VVvOo1NQdffwMxjrKkfy5Hmn1KkHq2Fradi2Q9hEvmr8DJM05EXTX2aiSaNUqihC1TWzESjcLEhW6a2lRYnDHHmFOejVnlWfnPNk9twUg0Cinci1inO9dRKTRepiA/u4LFYJREKckD0mXfVE2MR5MQe+nLUArdOH3mKXnHm8F4fPgJ7GjuzD1ItvMfl44JZ3fmhfEXQHuYYSEAkY4xuzQbx6fdaY88NFUTD+58BFWvglCFWFRZ0AZifLXkFdlQWpabvJpzumQk2FYps1SBGRBaMUjyPwOvjmJ0vxvI4HWDCqsgbr3s/gd0pNaKiiQkysjJoIuRWJmJVhZx/9Vpq3D1osswpab2aXgpCz+yRSRIYCQcSRpNaZc72dFCLKwsREmU8grWT8fWox7XC82+QtzOCl1+V15ylCSxq7kbm6e2IKBiB900FgIwGo1jZ3NXYqR7SJ4VNCpeGefNOacAKb/x5ZvyRqBZ7cogGpIkNGs8P95qqLnhNRJT8RTeOut09AV9iHQEIsJdW4fw3MTzqMgKYsTo8rpyAKUNmX81h4ZGl4Gly76b2EcDIUP/0CRsYEuj0OBXU0HFI1FXj991yQN3g0GD1w3qg85AsmQdAAJP/oMnidhgdTclD1qTYYn3OKnvLZgZzEjc6r5cEiEPnXr87rxx9tDOR7Ctvj0vkyY9EIXje4/JH17SYHshhXx0StBjzC3PwbzK3Pwhb5rajOFwrADPsHdPAOgLejC7NAsRR3lZ1TUf0lBNHNN9NE7qOwGKNXzh49mx9bhr6xp0e915yKU5WXBL0l1ZksRwOILNU68k33MPRuiRxK8e+cv59WnW+JfnvgyfvBx6sjvcnd4rAQ2Nml/F0trhCHXn698bYmFXY1chr5xbnoNF1QW5ke4To4ld9aTimG22hrRmlHwiIenvQMh6H3xQGsjQyiEFBr0U9dxIU/GzpbIQRqpRlPilZDE2VIizZ781B9/RPinsepiMp3DR/H6URAk6jcv/dcPX8nkSE3SchUrZLvb8xEtpqOSyPYFIhziidjgCkfQ0ksT2JYS6Uehu+yLA1vrWfBZepWXb2eVZe0ycJXmYiqfw344YgBQSKi2FfuKJT6UddCrmOeW5WFRdmBvDK/WtGI1G275rfn+Ej13N3bhkwUqcOet0RDqCJzwMvvQtPDb8eA6r94WPl6e2oJl+ZtbTuGrRZQn+i7yfKdzKJkFfnHgpB5lmJfjLFlyM0XAMPgV7PadEkf2fyJL5axV9NAVSyKn4pdN7+Btg0NDKIfV6runXOwfh/jX9cv1VtzZLkj7jlwQRmF10pJTnEgH6510AAuGY7iNR8sp7jHED4WMkHMXi6iL81jHvzZP2b7z4TTy485Gk8pKXdzWqspyP2WbhyabJTR0bbARAaZWHNNm5np940WrdMQLhY1t9O9bteCjNI5I59/PmnNMRH+YLH8PhCN4663S8ffG1iHSMQAT4/LNfwt3bfoCevFGWXE2kIyyqLoQv/NzoXphI5+itx0cg+On9ObJrKf7XSX+Y92YeH/4J/vIn/wddfleOQgiEj01Tm/H48BPpvUgoXN9x+LV415J3YnN9CyIdpZ10WfjjpX+b4ZhmjbIo4bnx5/HCxIuG52L8xtHvwWULLsKm+hbEHHc8pyCZ+3bT2WhLH5IIiJm5UpEUCPH3n17+QP319h77JUkfWpF4kTlB8O8Yj1+mQArmfGoyHxYhCDRUE0d3H4lTZ56U81SNReM51Lt100RezdnW2IHF1UX4+7P+D2aVZsIjD7dsvgOrH/8bdKcPP8FTeYi0Qo/fjaVpuVaQwPbGDmxrJKA/+1Ymn+lBg7E0hXUIo2sdCL+wIJIdM8AX1v9b0o9J4fm/ePgvYF55Lsaj8ZwjOFtQu5u7sbA8D397+l+hLBN+ry+u/3d84slPoS8olmwzY82uRaUh4k9GnoKGzu9Rdn9CHWJ7YweO6T4SX1z+WSysLoAvfKwf34APPfyxHMWMPN8QYNb4tw1fTXf1ZPX5wsffnvFX+KtT/gwLKvNRj+vYHQ5jd3N3/mdn+vdENNEWYk3FU/i3DV/LYUEAo+bV8P/O+Qz+5ITfx+zSLEzFU9jdbD/ncHMYddVMQj5rxDbPYVP0UhAI4U3Fr5BofhEMytoNr+fh7QdKCu6/p98bXDk0sfLW5X8tKuKzY6HSJtgs6YgSQt3ARfMvRCAChDrEktpiXLvoSvxw+McYDUfTWr2Gn5YBF1UX4j0L3oXfOeZ9mJGWVr/x4jfxF4//DTySuetu6iaG4zpiVrhw7nno8rvQ1MmOvrWxDbvDYYQ6RLfXnSe6BEqQwTpEt9eFE2csQ8wqpxRi1hgLx6BYo9vryhuDNa+Kx4efwN88+Sn86YkfhWaNOeU5+OvTVuFPfrQa2xrb88TTFx7Onv1W/PVp1+eL/u+f+Rw+88w/oSfo6ZhPnNBzXB4iMhg7Gttz+tUM+1USARZWFuCaw67A+47+NXT73QCAO7bcjT95bBUm4ymUram/bH7/5i134ovr/w3vO/rX88qfgMB7j/41/PIRA3hm9Fk8OfI0onzkOfE3S2uL0ev34g8e/RPsbOyCL/00N+zB118cxBmzTsPbFl+Tn7MsS/jQ8R/Abxz1q3h69Bk8PfZsDivJQoujuo6ELzz8waN/jMl4CoAEUdokNFEZmrla9UW5Hn/q9ksfHX2tsPb9Mg+yp2nDVdeDvry0Pzh8fvh406Ojmw3Nglr8WUQCE9EkvnDOP+HCeecV3r47HMbLk5uwaXIzRqMxLKwswKLawrz5BAD3brsf/7rhq1iz7T50+125cYQ6xJFdR2Bgydtxzpyz8gEc83hpciPu3voDfOOFQWya2oKSLKGh6rhw7vm45rArcO6cs/PegHk8suuH+K+N38V3Xv4+AtliWklmJEbxG0e9Bx9Z9ns5XHwkHMXQ9vvQUE0wayzrPR4np8NZP9r1GP7umc/iB9vXoi/oTSHu7QWDRtzA1y/4V5w+85Q8no90hBcnNmIinsALExsxpzwL88vzcExP6/48NfoMvrzhq/jOy9+HL3wEws+LGa7QdSqewnuPfg9+7/gPoObV9ukxPzHyFL684au4bctdhVHkrCoW6hD/47jfxm8e8xsodZh0tI+Hdj6Kzz/3L3ho16M5LMWWzgZDwxfUw3rj0d3ipC/dsXYS1+fgjUPAQAAM8IAcpEF1ye3nvnsqkF+fGI+UpFZQnsIDMKM0A8t6Etb2t/Qeh/mVeTiiaylKMhmkyZp9m6e24MWJjbh/xwO4f8cDeHZsPZg1utOYPYN9jEcTuHzhJXjb4muws7kL68c2tFVOlvUejx6/G1947l/x2PBPUPNqqKs6fvfY9+O43mPx5MhT6Ty5yHfaOaXZOKr7SLww8SI+88z/axuYyozkmJ6j8e6l78QZM0/DEd1HoMtYbC9Pbcb929fhls134JFdP0y8mN/tTOizqlPJC3DTyv/CvPIcMBj1uIFX6luxuLYoD7E0M+qqjg3jz+Px4Sdw3/a1eGDnIxhLx1z3hWyCQBiLxnBU95G4ZlGySRzRvQQ++fn9nYwnsWH8eTy6+8cY2nYfnhn9KeK0msiO8zEY49EElvUej2sOuwJnzT4TS2qL81yQwRiLxvDc+AY8vPOHuHf7Wjw3vh6CCF1eV+6pbFI4pVl19wWyNBm+9+4rH/xyttawHzm69suxileJ67Gaz7/lnPvCslweTsaKiKQJGQh1jLpqQqV4p5Isodfvbc0JpHHoaDiOUDcRs0JZlFDxKk4mEAKhoRqYjKdSNhBbIDF5DzOj2+8qlITH4wmEKsy7wjZkQ0NDkpfjwlwlzrqqo6EaqMoqetNpRBggwSk1BY88VL1aXjnqNCZcj+s4rucYfGvFf6T3S2Dtjgfxa/e/H/PKcxM8GLdQzaPhWDLMRQJdXi0Hcv4sJdqGamBK1VESAWYEM+AJmVcem6qJ4XAUMccoiRIqXjkfxNrTOafiOhq6gYosY0bQ1+qQE1CPGxiJRqFZoSTLqMpyCkHSTgFP1tClmhQ9kXrsb2ZHZ33vjEfVatp/gsn7lbH5qcGniK6DvvwO8dGGxv1RijDL1p5KE8JAlArKUGPRmKP646Ekg3xn6rSwGIyyV85JAPbWkS9M7vndIH9vdfrOn61YoZTS1mjWbd/DEx5myBn5OfY0Jpwk3RGO6FqSEkGECCjASxMvJVQ88YS1MAkVr4waqgCSeZmflQFGsUIgApTToamJeLKw7giUh7M55Sv2znhZ8cqoIrsn420bQa/fncri6da95STnsKtZLMA1AZQD+uiZZz4aDdwwIIHB/Sbqsl/5NgevG1QDNwzI2y5du06H+iulLk9qzaroMhmaFVSaECcTce1YnWxBZ6/bs4RwMoG3tz8uWPne3rOvn+36HtmC2TcOqeS1R6Qgy+xanxl7DgRy3CNpfG/9GtJHzq/Rs3BTWWi0r9/Bvq+ue5J4oOyc3LYozXmPWLOqdntSNNU3brpo3V0Zacj+XMP7nZB28MlBxioIoeM/qoZ6Z1CSlFIdtSAnLo1B6384JGk0X/13yHKqo4weDgBsGH8BXtoJ39/3aH88h305Z8bJa6qWEYMrJUFBUw3HWn8MDFr25OB+Xxj7n7F5NfTA9QM0dM3DWynGx4KyECBWJrZm+nCFJglX1LFp5c5L0QOv1F+BL703vVQDcxGYKIiVX5Giwvizoase2jQwOCBWr97/KuIHhNJ8kJJQ6+4r135Z1tWdlS7fA1qh1vThxprNLM3Agsr8/Mc7GjuSIak9jNm+SeQJbU0Z5VU9z5/UP7j1snWfPRCh1QE1kEQfbhmDQbN8+p0g1mPSE0Q8zavuSs598qE4xuHVxfkoLJDAXRqqDl/4b1o9xULPg5PQigRREHOdlfodIvCygWUHbNkcMANZTav1wOCAuPHitRviKP79SlUKDVbTJmFXrkKMhCN4pb4dx/ceA8Uqp8gZDkewo7kLu5vDKbDzzWkkwiAe1GDV3e2JsuI/+cE1Dz49cMOAfD1mzQ+KPgj2wMZ4/i3nfiuuyndMjkaKiCQOlOs+iM1DcYz5lXk4a9YZOHfOWbhi4aXGMFbyLe58ZQ3u374Oa7bfhx2NXR3h94fyIbOxCM2q1uPLajO+6e7LH/iF/dkQxBvRB3EdK9YM6aFVEIvLwfs3N8MzmyW5WDW1JoLgPbhcl7wW78Xq2RjuF2ivmLnOsbfzmp8tqJ2pBR3IKKiD3ncG45Yg1FUTly+8BNcsuhyCBJ4YeSrvZXBayTqsthDvWvpOgAS+8vzXE8wVc9s9sfUz9vadsA+/N2W70eF91GFD4n3Ypc1ZEDC0DISohHprr/bfDwZlymZvhNrVAT2yJGvlbedeGHp0d72pwRpCA8RclNgy+XvJJatgERmb79dGDCmsOWbXjciFWYxKijAIks2JNm0wasBhxG0hA1qGKlOyCs2AJwiKOTWUBLHcVGE+xGR29JM+QVIjL4sSZEr5Y98XdrDrk0UBa45DFzRcjH9rdrPRmOcy+xQmc782uAdsOXDzWoVJ3ZP+QjNYSqhSID0RRpevveqh2w9kYv6GG4gZavXfdM7Hoh7/k5OjYSyIPN6D59AOsjlblEdSaxqtjcmxgxfKYl4mi6+LigQTBW08y2BgnAuW6qptKLbRo7DwyBi4RVt/QBQ6+myOnuaLXid9g8JCF9RZkoLNxWpMgMa6qMnh8gpkSVvY8gS2fDMsYxTpZkEFD8Vx94zAw0j4Z/de8+Bf7i+k7kFtIACo/55+ObRyKF5+8zlfR7f/7onhMCZBnslkwYa0lnJ2adOYlYshle2JTM07ne7i5s5Oe1DAshezSWFU8BDcip9Ng87+7RkQG6Co/216wIIEsrULu8IbsjTpiWz9R6N0at4LKnqAgpa9dU22BBrZYZelVQ7L+AvwEbZRy0ZYqDiu9fleZUoN3nXFuutS41D7C2t1MBtIAovHKhocXFOd1xeuaQbyjImxSEGQJGsXUoYunR0OkAOaoJ0SC8YDM1YbdTIShwGQ467ZGhVtO6ixQMxrsKkzqRV/gw0tebZCHXOhmZ9pWk9h0AjFrrR5Tpe3ZstYTXYR1/fiDs+ErXPYxgVYjO3MKqh5shrxjwLULli+9o766v0EYz/oyrydhqtWA3jquqGJuK4GKFSb/LKUxIkYhPnQ8wdNxSdtN1LYCm/SgbbCQxEOdgyxDwkmGX9M1VVbak5Se/hkg+7ICsm4QyhINljPWtGm1xCORL2Qx6GYp5mz3vaFaVvizABFmwUINgoBtqQec7t0GhvfwcyVAFZBScqK0luEwsAdl98xietX4Y00jjfeQACAVuuBGwbkvW976IVe1r9UEZiSnhDgROpUOHIRYaxsacXH2tTUtlkxTNVUa9aZ4aCYsQ3NZNugljfJwjw7ESZ7kRgGzEaCqg1ohZ3jsLFw2VENYPP99jVbWuImbNyM+81ql1lqNb2TqXlP5kZlexGj0iWpWAjQRn5j2bkmIURNUH0Wi3fec9XaDQN8YPsdB2eI5UjaL/r+2VdGZfm9iSYTKSYmEMOdS7QB2gwDKZQ5yVroluHBTl7T10gj7zGTdzs2h8MQO+YKLnZJtIdQZkhjhjsuI6AOCb8rdzLJwl1FDFjJva11X7gWK3yy39MpVylclwYLDzyzLFhO6Wtuv+aBW9/IpPzg8yDIKYPi/nv6vbuvfvAW3eT3l8pC6ESajm2dQ7YqO4yW8imZOxQ56vAdvBJR8WYwt3ZZYVGnwlHBKmgvWguXuUhlI41SsrDKsMJKWmHt4C4Px1bJFlbOQ2g3imwD0QmcI9ndrS2TYOVQlkeymfu1VWDIwzJq34AEAYLBng9dq0ihQ/VbB5txHFQGYhrJ/Vet+xLq6kOlipQkoZVKZN3aWPfY8gAddm5YCam2QzG7R0DtyXQhHyBr96eWwWgrtMlifW2cX1uLXJC7wtSWA5k5A7eHUGbeoLkonGonx2yRQJNZ7bIqYLmyE4rKsm29FnKX0W3q2fTZsZCkSyUp1WT8u/dc8eC/HmzGcdAZiGkkD1z9wD/Khvq9SkVKIdPpUhQbeeYOmyWSitv5W4mKi8YuLZJVTXJ1fk2FXjvpL4hJcrFMTB2qZLb3ARc9ovlwbMkx06OYO7nJXtkW8lGx2QmHCE32Hez7ZG4WmVcwPYb5LNpCVUf4Bw3WBF2uSCnr6kPrrnnwswejceBghidlN2z5zed8SFTl349PKi00wBkzSqvr2pbAa7tzzG0s+4XKVcztFSZXE5Kog8GYnsCuGHXoCbj6LQVb4WJz0JVfkFVSNhNus78izH6Itcvbde08R3AVGahzkzArOJg9LDuBz22IgGrVE3oq/tADVz/wjwercRyUHsT2JGuveuAfyg1+f09JEHkkWHNSkLHdOrWLghZ2a2p5mVydyKpoFTyAxSAuRfu5s1DMXtwa7Z5EOJR9MyOTHSYryaqUFQoFrkVr6dKDHNUwhxEKtIeNwvCUptdwnYc5LWZYIactlaaZNQkSM8qSZkb6tw5248BBD3A1PMnKW86+Nva8bzSYK82GUlKQ5A6wB95D88+ptW01AsnqzJNBmJx3jK0kdV8Ae/bP7Ji/AAak9mYmLI/BcFeJYH0nu1qVw2bYfb/sRp9BuljAUrGjiWnmKIV8ipM+hwduzIR+1/cve/C7B7txHNQexPYk91z54HdrrK6sCN7i1TypdU7zVwAk2nV/thqGHaGl1oPNxVqMhZjBU+wOvnBwN2UkzHYhQVghGTnk6ewGYSEJNyt0xou1wxrNsqo2GqZ2szD73p7hhRU7oCTWNXqGqE3mKsjyqIIAYo7LVU/6wM4uxtWHinEcEh7E9iRnf/PsY4JecUMYyFObY1GsQR5Zu20BGuLogdihSCG8oSLQz9wR2aqY2bkD0FnuWlKrp+LCV7n6MDCu1ya5MBNtl3HZ35/tBqPhqZgth0XunhOsPoZZrnZyWCU/iCvdvldV/ISa1AND16575lAxjkPCgxQ8yap+78FfevC55lbVHzT1N2t9gScImjllGbPia+lIFM0cQFtQCeHohYCKWtzCqBYJq/fggpfknesOJehCSGJp8BVo/43VLx27el6lMzvqlnG09W2oWLo2m5yiI4WPhcWyKoZZXqY1GMSqpy/wumJ904u7GucPXbvumYEbBuShYhyHlAdpPdVVAikE4cLbl/85S1rdVIx6mpfY3XMblm7Pi5gwdVclyAYSioKCrBFWoL2CpVGEoWhHKOjyKNpaoFkIFxkwdu6QEwgr18h2eWF5OO6QG9lVMfs1LuSCXaQgZuX5QvqBQBDxJ35w+do/ZrTmgHCIzcjjEKS+yEYn9CV3nHt1E/T50BeLookoBkhmg1eFsmUKN9d7CodMGImjLyIcSbgLGt8GFzFQq/aciR0a2RUnNgashAmhd5SmtQUnIWt4SVBa0nYUK9hGALTNn7QPTLFTW4Vjr+Z5vczDvUS/c+PF99+AVRB4g1G5b/oQy0YBg6D77+n37rx03fcxEZ5bidTNvX2Bp0HEYEVmt52L9X2zWmMvcrKqW9JSPYIFGc8WXmFSjtuhFmT0YISRdGchkeJiGNbmEbKSNLmh+manmxw4K20VDNjhxbQDOaCtMrUpYmMRkWswuGdG4M0E39ecCM+98eL7b+i/p9/D6kPTOA5dD4J2FnkAWHnH8o+FhP8dEZUak3EsKKGHz3Ztj4pKRcIC4ekO8yNmw7EwB2GFSKYHsGdC0GGeXlghmd0EtEGTZmJuFhuU5Q0lAUq3Xy85vIUZbpr5mInA7VS2TiWzY7/seRUwS/DHj3k+XP3Pv/1odCgl429aAwEArEo3uNXQA3eec9YIic80AnnO2FgM1loJIkmO3dI1w20O8NjhUFvOwI7OM9qrZgX1VmsykjrMardVpB09EdeAUqdwyEQXKMPL2PdBOEI9c/pQcyFkVATIWq8P0YifLCv60O1XrL0HAFatwgFhPpw2kFfhTc74/Bn+rKPLH5nS+k9DT3ZHk7HOBvCy5Ftx0SjAcOriZYvBszvJXCyZwhg5FXB3r83qkHIhcTsMatlwD9eubjYzBdpnOYQ18Wcn8LwXSI2VuGtmcKkmpa+08kGf9vXE9Xdc/vjkGz0iO20g+6BJkg3aXH7L8uMaHv5aeeIdkWKE9TgmkFQJgUjb/Ahc46iOEKZTOETkpsxhB0REOObO2eVC7LlxuMM27lBNK2jTd4Dma5fnQ9Ho09yKBbESvvTKZQER6vvKiv/o9ivWrcUhWqX6uTMQmxACAH7h7uVvU8BfjHvy5Km6QthUsUzzk04LTzjKrtrqtus9hD7kmJuAw5DaZsUdJWXsxQDN+Q7TKwqHYbNFl2Q2+9hhrGniz4JYSSm8apcHr6lfCsB/ecsla78IgAduGJCDA4P6UE3Efx4NpJWbXL8KoNX6is8cXaIT5v3OmNYfERVv8dRkjDjSCkyJoFSHmr6wYBcEd59EO/IK8w6TXf2izjQ6LpYT29BcA0gmvstsWGZoYKWLFTVpG0w7FxkLQAlJXle3B9FUo1VJ/xg11aduv+KB3RnpxsEwGjttIK8DUR0AXPytt87iHv+3I43fi0piXqOuoCOtPCLSDCFEsRvdxupo0eWYnoRoz4yNrnjfBRA0CwmusVa7R0Jpidju1dhwE2WFW4wkt1Lc1tXX4ETXulyT4IYaLwn60nxP/d1/rnzwRbt6iDc30f7PzUEDPCCyh/qO286dO+GJ9ynNH+SyPGyyqdCsay0oYdxRBh6QLXyXOXdi0+e0YbM6TNbB8iJ2t9scglLcTidqlndtuLttpNoR/rkYW8CsFcB+IGWtJiGm4hEi+rexCP/w6FVrN+SGgTdnOPXzbiB5F75/TSs/+ZV7z58xHPGvTMT6N7UnTlVECKcUYq1jAglBEHZHWTgWfxvs2ySXM4xBG+RywjFcVaDo5M5UQeYcvg3Lt1km7WsGA0IknidmaAJrSeR5FQkhCaVIbewS4l9J40s3XXr/xtwLPznIeBOUbqcN5FUYygAPyNE7N10ZMb0vZL5SlWUpCjV0QzPAiokEANGJPYQcPRbt6Iy7yNz2lKyTox/h4i82OW71HiYk86Y8s9aACAIpgrKAaGqUBO5n4i/qseDbQ+8YGvl5NoxpA+lgKABw+V3Lj9OaBzRoICI6WQUCYVNDNVXCyp+AXQSllETkoNoBdcBZOQzMZonvVIa18xzbU7EBjbHogVgzmMEaIEE+iVJZQmqGjPlFH/ztnpL3jRv7730I5njBiiH18xJKTRvIvuQoNwyIZQPLOKvKMK8SV9555/KI+G3EuHKScUJcEtAxI25oaK2VRMo1zSRSAKWTPM7OH0wPoTpwCQPt5WB7ktH0Sn4KRkwFQxhgTckVSQoEKmUJijW8SL8Mwl0e4ZunzOla839PvWPSvAdv1pLttIG8juXh/hX9wvQqAzcMyFd6N54Joou1pks143QuiR5IQhQxONJQEbMgVozcVIgZJFNP45JwIAc4ENS5glaAt3NGh5RAMiXAKtFLkEFJgHyRlHinYl32xFMg3OVp3NwX+GsHVw5NmAiEZWhtDNPHtIH8TF5l+5ztZIPult++fGEf4a1jis9TwDmCcYIX0MyGJxKgYMxQMUPHDGjOKsec6HkkABadWoxHIJUS1UmLsTBlO8pDpaSnQaQTvyWERyAp4PsEEgDHDC/UTYDXlwU97ElxbxN48O6LLnmaDAMYuGFAAsC0t5g2kNffWByx+Xt/cP6crXUcO8X6ZCI+aSLmE7o9OjxUPF8Gsqy8BBMfgSHTfkSkW7h3bbMjEpIkRwCUug0tEsEd0gypgeZUzN1S7GDmV2LwcxVBj08yfrS04j35lQvvfZGsa+y/p9+bu2MuTxvFtIEckOR+YLCzwQDAh26+ovSIHp0/u8qHTUaYy0xHNRjdPRJLmop7mYhKArPrmvtiDU8QkUdAlDgdlAU1AexSzCMVj3RT4cWYMcJML/hC72TBL82b2b3lm2feOcodGqTp9WUGMW0U0wbyxhsMAAytGdI/U2l0lWN47Wd4f2YMc3fM5WVPDvLq1dMGMW0gh8Jo8PWggRMGCAPA9jWJ8czdMTdfuHsNd1ZBDJwwQACQGV92jsEnB/lQHWWdNpDp4/V4DtMLf/qYPqaP6WP6mD6mj+lj+pg+po/pY/qYPqaP6WP6mD6mj+lj+pg+po/pY/qYPqaP6WP6mD6mj4Po+P8B/+Hm5DLsMAcAAAAASUVORK5CYII=">
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
  .app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }
  .top-bar {
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: #fff;
    padding: 22px 24px;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0,40,80,0.18);
    position: relative;
    z-index: 1;
    overflow: hidden;
  }
  .top-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse 280px 90px at 50% -25%, rgba(255,255,255,0.28), rgba(255,255,255,0) 70%);
    pointer-events: none;
  }
  .header-text { text-align: left; }
  .top-bar .title { font-size: 21px; font-weight: 800; letter-spacing: 0.2px; text-shadow: 0 1px 4px rgba(0,30,60,0.28); line-height: 1.3; }
  .top-bar .subtitle-row {
    display: inline-flex;
    align-items: flex-start;
    gap: 7px;
    margin-top: 8px;
    background: rgba(255,255,255,0.18);
    border: 1px solid rgba(255,255,255,0.22);
    border-radius: 14px;
    padding: 6px 16px;
    max-width: 100%;
  }
  .top-bar .subtitle-row .status-dot { margin-top: 5px; }
  .top-bar .subtitle { font-size: 12.5px; opacity: 0.97; font-weight: 600; line-height: 1.5; text-align: left; }
  .top-bar-inner { display: flex; align-items: center; justify-content: center; gap: 16px; position: relative; z-index: 1; }
  .brand-logo { width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 4px 14px rgba(0,0,0,0.25); }
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
    font-size: 16px;
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
  .input-inner input { flex: 1; border: none; outline: none; font-size: 16px; font-family: inherit; padding: 8px 0; background: transparent; }
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
  /* ボタン共通の「水っぽい」質感と、押すとキラキラ輝きながら軽くプルンと弾むような演出(弾力は控えめに調整した版) */
  button { position: relative; overflow: visible; isolation: isolate; }
  button::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(165deg, rgba(255,255,255,0.68) 0%, rgba(255,255,255,0.18) 30%, rgba(255,255,255,0.02) 52%, rgba(255,255,255,0.24) 100%);
    mix-blend-mode: overlay;
    pointer-events: none;
    transition: opacity 0.18s ease;
  }
  button::after {
    /* 常にうっすら光る水面のようなハイライトで、透明感のあるガラス/水の質感を出す */
    content: '';
    position: absolute;
    left: 9%;
    right: 9%;
    top: 10%;
    height: 22%;
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0));
    opacity: 0.6;
    pointer-events: none;
    mix-blend-mode: overlay;
    transition: opacity 0.18s ease;
  }
  button:active::before { opacity: 0.28; }
  button:active::after { opacity: 0.95; }
  button.btn-jelly { animation: btnJelly 0.48s cubic-bezier(.36,1.25,.46,1) both; }
  @keyframes btnJelly {
    0%   { transform: scale(1, 1); }
    20%  { transform: scale(0.93, 1.07); }
    45%  { transform: scale(1.045, 0.96); }
    70%  { transform: scale(0.98, 1.015); }
    100% { transform: scale(1, 1); }
  }
  .btn-splash {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    border: 1.5px solid rgba(255,255,255,0.6);
    background: radial-gradient(circle, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.08) 45%, rgba(255,255,255,0) 72%);
    box-shadow: inset 0 0 14px rgba(255,255,255,0.35);
    transform: scale(0.2);
    opacity: 0.8;
    animation: btnSplash 0.78s cubic-bezier(.22,.7,.32,1) forwards;
  }
  @keyframes btnSplash {
    0%   { transform: scale(0.2); opacity: 0.8; }
    45%  { opacity: 0.45; }
    100% { transform: scale(1.55); opacity: 0; }
  }
  .btn-sparkle {
    position: absolute;
    width: 11px;
    height: 11px;
    margin: -5.5px 0 0 -5.5px;
    pointer-events: none;
    background: radial-gradient(circle, #ffffff 0%, #ffe9a8 45%, rgba(255,233,168,0) 75%);
    clip-path: polygon(50% 0%, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0% 50%, 38% 38%);
    box-shadow: 0 0 7px rgba(255,233,168,0.95);
    animation: btnSparkle 1.05s cubic-bezier(.22,.61,.36,1) forwards;
  }
  @keyframes btnSparkle {
    0%   { transform: translate(0,0) scale(0) rotate(0deg); opacity: 0; }
    12%  { transform: translate(calc(var(--dx,0px) * 0.15), calc(var(--dy,0px) * 0.15)) scale(calc(var(--ds,1) * 1.25)) rotate(calc(var(--rot,70deg) * 0.2)); opacity: 1; }
    60%  { transform: translate(calc(var(--dx,0px) * 0.6), calc(var(--dy,0px) * 0.6)) scale(var(--ds,1)) rotate(calc(var(--rot,70deg) * 0.65)); opacity: 1; }
    100% { transform: translate(var(--dx,0px),var(--dy,0px)) scale(calc(var(--ds,1) * 0.2)) rotate(var(--rot,70deg)); opacity: 0; }
  }
</style>
</head>
<body>
<div class="app">
  <div class="top-bar">
    <div class="top-bar-inner">
      <img class="brand-logo" src="data:image/png;base64,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" alt="Shopee">
      <div class="header-text">
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
  // ===== 回答が届いたことを分かりやすく知らせる(音を鳴らす＋タブのタイトルを光らせる) =====
  var baseTitle = document.title;
  var audioCtx = null;
  function ensureAudioCtx() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } else if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    } catch (e) { /* 音が使えない環境では無視 */ }
  }
  document.addEventListener('pointerdown', ensureAudioCtx, true);

  // 回答が届いたときに鳴らす、短く控えめな通知音(ピンポン)
  function playNotifySound() {
    if (!audioCtx) return;
    try {
      var now = audioCtx.currentTime;
      [660, 880].forEach(function (freq, i) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        var t0 = now + i * 0.12;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.2, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.32);
      });
    } catch (e) { /* 無視 */ }
  }

  // 未読の回答がある間、ブラウザのタブのタイトルを点滅させて気づきやすくする
  var titleFlashTimer = null;
  function updateTitleNotice() {
    var unreadCount = rooms.filter(function (r) { return r.unread; }).length;
    if (titleFlashTimer) {
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
    }
    if (unreadCount > 0) {
      var showingAlert = true;
      document.title = '🔔 回答あり(' + unreadCount + '件)';
      titleFlashTimer = setInterval(function () {
        showingAlert = !showingAlert;
        document.title = showingAlert ? ('🔔 回答あり(' + unreadCount + '件)') : baseTitle;
      }, 1200);
    } else {
      document.title = baseTitle;
    }
  }

  // ボタンを押したときに、プルルンと弾んで水が弾けるようなエフェクトを出す(全ボタン共通)
  (function attachButtonSplash() {
    document.addEventListener('pointerdown', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || btn.disabled) return;
      var rect = btn.getBoundingClientRect();
      var x = (typeof e.clientX === 'number' && e.clientX) ? e.clientX - rect.left : rect.width / 2;
      var y = (typeof e.clientY === 'number' && e.clientY) ? e.clientY - rect.top : rect.height / 2;

      // ボタン自体が軽くプルンと弾む(弾力は控えめに)
      btn.classList.remove('btn-jelly');
      void btn.offsetWidth;
      btn.classList.add('btn-jelly');
      window.setTimeout(function () { btn.classList.remove('btn-jelly'); }, 480);

      // 水の輪がふわっと広がって消える
      var size = Math.max(rect.width, rect.height) * 1.5;
      var splash = document.createElement('span');
      splash.className = 'btn-splash';
      splash.style.width = splash.style.height = size + 'px';
      splash.style.left = (x - size / 2) + 'px';
      splash.style.top = (y - size / 2) + 'px';
      btn.appendChild(splash);
      window.setTimeout(function () {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 800);

      // キラキラした粒が数個、弾けて飛び散る(大きさや回転をランダムに)
      var sparkleCount = 7;
      for (var i = 0; i < sparkleCount; i++) {
        var angle = (Math.PI * 2 * i) / sparkleCount + (Math.random() - 0.5) * 0.6;
        var dist = Math.max(rect.width, rect.height) * (0.6 + Math.random() * 0.4);
        var sparkle = document.createElement('span');
        sparkle.className = 'btn-sparkle';
        sparkle.style.left = x + 'px';
        sparkle.style.top = y + 'px';
        sparkle.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
        sparkle.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(1) + 'px');
        sparkle.style.setProperty('--ds', (0.7 + Math.random() * 0.7).toFixed(2));
        sparkle.style.setProperty('--rot', (Math.random() > 0.5 ? 1 : -1) * (50 + Math.random() * 70) + 'deg');
        btn.appendChild(sparkle);
        (function (s) {
          window.setTimeout(function () {
            if (s.parentNode) s.parentNode.removeChild(s);
          }, 1080);
        })(sparkle);
      }
    }, true);
  })();
  var STORAGE_KEY = 'shpChatPassword';
  var READ_IDS_KEY = 'shpChatReadIds';
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

  // 質問一覧(部屋)は、誰が聞いた質問でも接客担当全員が同じものを見られるよう、
  // サーバー側(保留シート)を正として毎回取得する。「既読」かどうかだけは
  // 人それぞれ違っていい情報なので、この端末のlocalStorageに小さく保存しておく。
  // (削除は全員の画面から消える共有の操作なので、サーバー側で管理する)
  function loadIdList(key) {
    try {
      var raw = window.localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveIdList(key, list) {
    try { window.localStorage.setItem(key, JSON.stringify(list.slice(-1000))); } catch (e) { /* 無視 */ }
  }

  var readIds = loadIdList(READ_IDS_KEY);

  function markRead(id) {
    if (readIds.indexOf(id) !== -1) return;
    readIds.push(id);
    saveIdList(READ_IDS_KEY, readIds);
  }

  // サーバーから取ってきた1件分のデータを、画面で使う「部屋」の形に変換する。
  function roomFromServerItem(it) {
    var messages = [{ who: 'user', text: it.question, at: it.askedAt }];
    if (it.status === 'answered' && it.answer) {
      messages.push({ who: 'bot', text: it.answer, at: it.answeredAt || it.askedAt });
    }
    return {
      id: it.id,
      question: it.question,
      messages: messages,
      status: it.status,
      pendingId: it.status === 'pending' ? it.id : null,
      unread: (it.status === 'answered' || it.status === 'cancelled') && readIds.indexOf(it.id) === -1,
      askedAt: it.askedAt,
      updatedAt: it.answeredAt || it.askedAt
    };
  }

  var rooms = [];
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
      updateTitleNotice();
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
    updateTitleNotice();
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
      markRead(id);
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
    refreshRoomList();
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

  // 1件の部屋(=1回の質問)を新規作成し、一覧の先頭に追加する。サーバーへの
  // 送信が終わるまでの、この端末だけの一時的な表示用(IDはまだ仮のもの)。
  function createRoom(question) {
    var now = new Date().toISOString();
    var room = {
      id: 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      question: question,
      messages: [],
      status: 'sending',
      pendingId: null,
      unread: false,
      askedAt: now,
      updatedAt: now
    };
    rooms.unshift(room);
    return room;
  }

  // その部屋にメッセージを1件追加する。いま画面に開いている部屋であれば、
  // その場で吹き出しも追加する(highlightを立てると、新着が一瞬光って知らせる)。
  function addRoomMessage(room, who, text, highlight) {
    var at = new Date().toISOString();
    room.messages.push({ who: who, text: text, at: at });
    room.updatedAt = at;
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

  // サーバー側(保留シート)の質問一覧を取りに行き、画面の部屋一覧にまとめ直す。
  // 接客担当が何人いても、ここで取得した内容は全員共通(誰が聞いた質問も載る)。
  // 定期的に呼び出すことで、他の人が聞いた質問や、届いた回答が自動で反映される。
  function applyServerItems(items) {
    var prevById = {};
    rooms.forEach(function (r) { prevById[r.id] = r; });

    var justResolved = [];
    var merged = items
      .map(function (it) {
        var prev = prevById[it.id];
        var room = roomFromServerItem(it);
        if (activeRoomId === room.id) room.unread = false;
        if (prev && prev.status === 'pending' && room.status !== 'pending') {
          justResolved.push(room);
        }
        delete prevById[it.id];
        return room;
      });

    // 送信した直後でまだサーバー一覧に出てきていない分(ごく一瞬だけ)は、
    // そのまま先頭に残しておく。
    var stillSending = Object.keys(prevById)
      .map(function (id) { return prevById[id]; })
      .filter(function (r) { return r.status === 'sending'; });

    rooms = stillSending.concat(merged);
    renderRoomList();

    justResolved.forEach(function (room) {
      if (activeRoomId === room.id) {
        var card = qs('pendingStatusCard');
        if (card) card.remove();
        if (room.status === 'answered') {
          var last = room.messages[room.messages.length - 1];
          var built = buildBubbleRow('bot', last.text, last.at);
          built.row.classList.add('bubble-highlight');
          setTimeout(function () { built.row.classList.remove('bubble-highlight'); }, 2200);
          chatBody.appendChild(built.row);
          chatBody.scrollTop = chatBody.scrollHeight;
        }
      }
      if (room.status === 'answered') {
        showToast('回答が届きました：' + truncateText(room.question, 26));
        playNotifySound();
      }
    });
  }

  function refreshRoomList() {
    fetch('/api/ask-list', {
      headers: { 'x-chat-password': getStoredPassword() }
    })
      .then(function (res) {
        if (res.status === 401) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        applyServerItems(data.items || []);
      })
      .catch(function () { /* 通信エラー時は次回のポーリングに任せる */ });
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

  // 回答済み・取消済みなど、もう動きのない過去の質問を一覧から消す。質問一覧は
  // 接客担当全員で共有しているため、ここで削除すると全員の画面から消える
  // (シート上の行自体は履歴として残る)。確認中の質問はここでは扱わない
  // (その場合は上の「取消」を使う)。
  function deleteRoomLocal(room) {
    if (!window.confirm('この質問を一覧から削除しますか？(全員の画面から消え、この操作は取り消せません)')) return;
    fetch('/api/ask-hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chat-password': getStoredPassword() },
      body: JSON.stringify({ id: room.id })
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.ok) {
          var idx = rooms.findIndex(function (r) { return r.id === room.id; });
          if (idx !== -1) rooms.splice(idx, 1);
          if (activeRoomId === room.id) {
            activeRoomId = null;
            renderRoomDetail(null);
          }
          renderRoomList();
          showToast('質問を削除しました。');
        } else {
          showToast('削除に失敗しました。少し時間をおいて、もう一度お試しください。');
        }
      })
      .catch(function () {
        showToast('通信エラーのため削除できませんでした。少し時間をおいて、もう一度お試しください。');
      });
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
        room.pendingId = stillPending ? data.pendingId : null;
        // サーバーに記録された本当のIDに差し替える(他の人の画面にも、以後は
        // このIDで同じ部屋として反映されるようにするため)。
        if (data.id) {
          if (activeRoomId === room.id) activeRoomId = data.id;
          room.id = data.id;
        }
        addRoomMessage(room, 'bot', text, false);
        if (stillPending) showPendingStatusCard(room);
        renderRoomList();
      })
      .catch(function () {
        removeTyping();
        room.status = 'answered';
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

  // ページを開いている間、質問一覧(他の人が聞いた分も含む)を定期的に
  // 取りに行き、新着や回答の到着を反映する。
  setInterval(refreshRoomList, POLL_INTERVAL_MS);
  refreshRoomList();
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
    --brand: #e08a2c;
    --brand-dark: #a85d12;
    --brand-light: #f0ab5c;
    --bg: #fbf2e7;
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
    background: radial-gradient(ellipse 900px 500px at 50% 0%, #fffaf3 0%, var(--bg) 70%);
    color: var(--text);
  }
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  .top-bar {
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: #fff;
    padding: 22px 24px;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0,40,80,0.18);
    position: relative;
    z-index: 1;
    overflow: hidden;
  }
  .top-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse 280px 90px at 50% -25%, rgba(255,255,255,0.28), rgba(255,255,255,0) 70%);
    pointer-events: none;
  }
  .header-text { text-align: left; }
  .top-bar .title { font-size: 21px; font-weight: 800; letter-spacing: 0.2px; text-shadow: 0 1px 4px rgba(0,30,60,0.28); line-height: 1.3; }
  .top-bar .subtitle-row {
    display: inline-flex;
    align-items: flex-start;
    gap: 7px;
    margin-top: 8px;
    background: rgba(255,255,255,0.18);
    border: 1px solid rgba(255,255,255,0.22);
    border-radius: 14px;
    padding: 6px 16px;
    max-width: 100%;
  }
  .top-bar .subtitle-row .status-dot { margin-top: 5px; }
  .top-bar .subtitle { font-size: 12.5px; opacity: 0.97; font-weight: 600; line-height: 1.5; text-align: left; }
  .top-bar-inner { display: flex; align-items: center; justify-content: center; gap: 16px; position: relative; z-index: 1; }
  .brand-logo { width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; border: 3px solid rgba(255,255,255,0.85); box-shadow: 0 4px 14px rgba(0,0,0,0.25); }
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
    font-size: 16px;
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
  .admin-toolbar button:hover { background: #fff6ea; transform: scale(1.04); box-shadow: 0 2px 8px rgba(224,138,44,0.18); }
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
    font-size: 16px;
    font-family: inherit;
    resize: vertical;
    margin-bottom: 10px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .q-card textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(224,138,44,0.18); }
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
  /* ボタン共通の「水っぽい」質感と、押すとキラキラ輝きながら軽くプルンと弾むような演出(弾力は控えめに調整した版) */
  button { position: relative; overflow: visible; isolation: isolate; }
  button::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(165deg, rgba(255,255,255,0.68) 0%, rgba(255,255,255,0.18) 30%, rgba(255,255,255,0.02) 52%, rgba(255,255,255,0.24) 100%);
    mix-blend-mode: overlay;
    pointer-events: none;
    transition: opacity 0.18s ease;
  }
  button::after {
    /* 常にうっすら光る水面のようなハイライトで、透明感のあるガラス/水の質感を出す */
    content: '';
    position: absolute;
    left: 9%;
    right: 9%;
    top: 10%;
    height: 22%;
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0));
    opacity: 0.6;
    pointer-events: none;
    mix-blend-mode: overlay;
    transition: opacity 0.18s ease;
  }
  button:active::before { opacity: 0.28; }
  button:active::after { opacity: 0.95; }
  button.btn-jelly { animation: btnJelly 0.48s cubic-bezier(.36,1.25,.46,1) both; }
  @keyframes btnJelly {
    0%   { transform: scale(1, 1); }
    20%  { transform: scale(0.93, 1.07); }
    45%  { transform: scale(1.045, 0.96); }
    70%  { transform: scale(0.98, 1.015); }
    100% { transform: scale(1, 1); }
  }
  .btn-splash {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    border: 1.5px solid rgba(255,255,255,0.6);
    background: radial-gradient(circle, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.08) 45%, rgba(255,255,255,0) 72%);
    box-shadow: inset 0 0 14px rgba(255,255,255,0.35);
    transform: scale(0.2);
    opacity: 0.8;
    animation: btnSplash 0.78s cubic-bezier(.22,.7,.32,1) forwards;
  }
  @keyframes btnSplash {
    0%   { transform: scale(0.2); opacity: 0.8; }
    45%  { opacity: 0.45; }
    100% { transform: scale(1.55); opacity: 0; }
  }
  .btn-sparkle {
    position: absolute;
    width: 11px;
    height: 11px;
    margin: -5.5px 0 0 -5.5px;
    pointer-events: none;
    background: radial-gradient(circle, #ffffff 0%, #ffe9a8 45%, rgba(255,233,168,0) 75%);
    clip-path: polygon(50% 0%, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0% 50%, 38% 38%);
    box-shadow: 0 0 7px rgba(255,233,168,0.95);
    animation: btnSparkle 1.05s cubic-bezier(.22,.61,.36,1) forwards;
  }
  @keyframes btnSparkle {
    0%   { transform: translate(0,0) scale(0) rotate(0deg); opacity: 0; }
    12%  { transform: translate(calc(var(--dx,0px) * 0.15), calc(var(--dy,0px) * 0.15)) scale(calc(var(--ds,1) * 1.25)) rotate(calc(var(--rot,70deg) * 0.2)); opacity: 1; }
    60%  { transform: translate(calc(var(--dx,0px) * 0.6), calc(var(--dy,0px) * 0.6)) scale(var(--ds,1)) rotate(calc(var(--rot,70deg) * 0.65)); opacity: 1; }
    100% { transform: translate(var(--dx,0px),var(--dy,0px)) scale(calc(var(--ds,1) * 0.2)) rotate(var(--rot,70deg)); opacity: 0; }
  }
</style>
</head>
<body>
<div class="app">
  <div class="top-bar">
    <div class="top-bar-inner">
      <img class="brand-logo" src="data:image/png;base64,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" alt="Shopee">
      <div class="header-text">
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
  // ボタンを押したときに、プルルンと弾んで水が弾けるようなエフェクトを出す(全ボタン共通)
  (function attachButtonSplash() {
    document.addEventListener('pointerdown', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || btn.disabled) return;
      var rect = btn.getBoundingClientRect();
      var x = (typeof e.clientX === 'number' && e.clientX) ? e.clientX - rect.left : rect.width / 2;
      var y = (typeof e.clientY === 'number' && e.clientY) ? e.clientY - rect.top : rect.height / 2;

      // ボタン自体が軽くプルンと弾む(弾力は控えめに)
      btn.classList.remove('btn-jelly');
      void btn.offsetWidth;
      btn.classList.add('btn-jelly');
      window.setTimeout(function () { btn.classList.remove('btn-jelly'); }, 480);

      // 水の輪がふわっと広がって消える
      var size = Math.max(rect.width, rect.height) * 1.5;
      var splash = document.createElement('span');
      splash.className = 'btn-splash';
      splash.style.width = splash.style.height = size + 'px';
      splash.style.left = (x - size / 2) + 'px';
      splash.style.top = (y - size / 2) + 'px';
      btn.appendChild(splash);
      window.setTimeout(function () {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 800);

      // キラキラした粒が数個、弾けて飛び散る(大きさや回転をランダムに)
      var sparkleCount = 7;
      for (var i = 0; i < sparkleCount; i++) {
        var angle = (Math.PI * 2 * i) / sparkleCount + (Math.random() - 0.5) * 0.6;
        var dist = Math.max(rect.width, rect.height) * (0.6 + Math.random() * 0.4);
        var sparkle = document.createElement('span');
        sparkle.className = 'btn-sparkle';
        sparkle.style.left = x + 'px';
        sparkle.style.top = y + 'px';
        sparkle.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
        sparkle.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(1) + 'px');
        sparkle.style.setProperty('--ds', (0.7 + Math.random() * 0.7).toFixed(2));
        sparkle.style.setProperty('--rot', (Math.random() > 0.5 ? 1 : -1) * (50 + Math.random() * 70) + 'deg');
        btn.appendChild(sparkle);
        (function (s) {
          window.setTimeout(function () {
            if (s.parentNode) s.parentNode.removeChild(s);
          }, 1080);
        })(sparkle);
      }
    }, true);
  })();
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

['/api/ask-login', '/api/ask', '/api/ask-list', '/api/ask-status', '/api/ask-delete', '/api/ask-hide', '/api/promoter-login', '/api/promoter-pending', '/api/promoter-answer', '/api/promoter-delete'].forEach(
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
      await sendMessage(
        `${mentions}\n`
        + `サイト内に未回答の質問が届いています。\n\n`
        + `【質問】\n${question}\n\n`
        + `▼回答はこちらから\nhttps://shp-company.site/qa_bot/promoter/`
      );
    } catch (e) {
      console.error('Chatworkへの通知送信に失敗しました:', e);
    }
  }
  return pendingId;
}

// FAQに即座にマッチして回答できた質問も、接客担当全員で共有する質問一覧
// (/api/ask-list)に出てくるよう、answered状態のまま保留シートに記録しておく。
// (Chatworkへの通知やプロモーターへの確認は不要なので、ここでは行わない)
async function recordSiteAnswered(question, answer) {
  try {
    return await appendPendingRow({
      question,
      askerAccountId: '',
      askerName: '接客担当(自社サイト)',
      roomId: 'site-chat',
      questionMessageId: '',
      holderRequestMessageId: '',
      status: 'answered',
      answer,
      answeredBy: '自動回答(FAQ)',
    });
  } catch (e) {
    console.error('保留シートへの記録(即答分)に失敗しました:', e);
    return null;
  }
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
      const id = await recordSiteAnswered(question, result.answer);
      return res.json({ answered: true, answer: result.answer, id });
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
          const id = await recordSiteAnswered(question, answerBody);
          return res.json({ answered: true, answer: answerBody, id });
        }
        const pendingId = await createSitePendingAndNotify(leftover);
        return res.json({
          answered: false,
          pendingId,
          id: pendingId,
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
      const id = await recordSiteAnswered(question, result.answer);
      return res.json({ answered: true, answer: result.answer, id });
    }

    // Q&A表に答えが無い場合は、保留シートに記録したうえで、プロモーター用の
    // 回答管理ページ(/promoter)で回答してもらう。
    const pendingId = await createSitePendingAndNotify(question);

    return res.json({
      answered: false,
      pendingId,
      id: pendingId,
      answer:
        '申し訳ございません。この内容については担当者の確認が必要です。\n\n確認でき次第、こちらに回答が届きます。少々お待ちください。',
    });
  } catch (e) {
    console.error('/api/ask エラー:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// 接客担当のページを開いた人全員が、同じ質問一覧(誰が聞いた質問か問わず全件)を
// 見られるようにするための一覧取得API。即座に自動回答できた質問も、保留シートに
// 記録されていれば(status='answered')ここに含まれる。
app.get('/api/ask-list', async (req, res) => {
  allowCors(req, res);
  if (!checkChatPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const pending = await listPendingRows();
    const items = pending
      .filter((p) => p.roomId === 'site-chat' && p.status !== 'hidden')
      .map((p) => ({
        id: p.id,
        question: p.question,
        status: p.status,
        answer: p.answer || '',
        askedAt: p.requestedAt,
        answeredAt: p.answeredAt || '',
      }))
      .reverse();
    return res.json({ items });
  } catch (e) {
    console.error('/api/ask-list エラー:', e);
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

// 回答済み・取消済みなど、もう動きのない過去の質問を質問一覧から消す。
// 質問一覧は接客担当全員で共有しているため、ここでの削除は全員の画面から
// 消える(statusを'hidden'にして、一覧取得時に除外するだけで、シート上の
// 行自体は履歴として残す)。確認中(pending)のものはここでは扱わない。
app.post('/api/ask-hide', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkChatPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const id = ((req.body && req.body.id) || '').toString();
    if (!id) return res.status(400).json({ error: 'id is required' });

    const pending = await listPendingRows();
    const target = pending.find((p) => p.id === id && p.roomId === 'site-chat');
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    if (target.status === 'pending') {
      return res.status(400).json({ ok: false, error: 'still_pending' });
    }

    await updatePendingRow(target.sheetRowNumber, { status: 'hidden' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/ask-hide エラー:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
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
