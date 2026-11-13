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
