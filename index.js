import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import fetch from 'node-fetch';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import holiday_jp from 'japanese-holidays';

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
  faqQuestionCol: process.env.FAQ_QUESTION_COL || null,
  faqAnswerCol: process.env.FAQ_ANSWER_COL || null,
  googleServiceAccountJson: required('GOOGLE_SERVICE_ACCOUNT_JSON'),

  // LLM
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',

  // Scheduling / auth
  cronSecret: required('CRON_SECRET', 'change-me'),
  followupAfterBusinessDays: parseInt(process.env.FOLLOWUP_AFTER_BUSINESS_DAYS || '1', 10),

  // Bot behaviour
  teachTriggerWord: process.env.TEACH_TRIGGER_WORD || '覚えて',
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
async function resolveFaqSheetTitle() {
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

async function readFaqTable() {
  const title = await resolveFaqSheetTitle();
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${title}`,
  });
  const values = res.data.values || [];
  if (values.length === 0) {
    return { title, headerRow: [], questionColIndex: 0, answerColIndex: 1, rows: [] };
  }
  const header = values[0];

  let qIdx, aIdx;
  if (config.faqQuestionCol) qIdx = colLetterToIndex(config.faqQuestionCol);
  if (config.faqAnswerCol) aIdx = colLetterToIndex(config.faqAnswerCol);

  if (qIdx === undefined || aIdx === undefined) {
    const findCol = (keywords) =>
      header.findIndex((h) => keywords.some((k) => (h || '').includes(k)));
    if (qIdx === undefined) {
      qIdx = findCol(['質問', 'Q&A', 'Question', '設問']);
      if (qIdx === -1) qIdx = 0;
    }
    if (aIdx === undefined) {
      aIdx = findCol(['回答', 'A ', 'Answer', '返信']);
      if (aIdx === -1) aIdx = 1;
    }
  }

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const question = (row[qIdx] || '').trim();
    const answer = (row[aIdx] || '').trim();
    if (!question && !answer) continue;
    rows.push({ rowNumber: i + 1, question, answer });
  }
  return { title, headerRow: header, questionColIndex: qIdx, answerColIndex: aIdx, rows };
}

async function appendFaqRow(question, answer) {
  const { title, questionColIndex, answerColIndex } = await readFaqTable();
  const sheets = await getSheets();
  const width = Math.max(questionColIndex, answerColIndex) + 1;
  const row = new Array(width).fill('');
  row[questionColIndex] = question;
  row[answerColIndex] = answer;
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
その行番号(rowNumber)と、表の回答をもとにした自然な日本語の回答文(answer)を返してください。
表に該当する項目が無い、もしくは自信が持てない場合は matched=false としてください（answerやrowNumberは省略してよい）。
confidenceは0〜1で、0.75未満の場合は原則matched=falseとしてください。`;

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
  const deadline = addBusinessDays(requestedAt, businessDays);
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

    if (senderId === myAccountId) continue;

    const replyTarget = parseReplyTarget(body);
    if (replyTarget && config.holderAccountIds.includes(senderId)) {
      const handled = await handleHolderReply({ replyTarget, body, senderId, roomId, log });
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
  }

  return { processed };
}

async function handleQuestion({ question, senderId, messageId, roomId, log }) {
  if (!question) return;
  const { rows } = await readFaqTable();
  const result = await matchQuestion(question, rows);

  if (result.matched && result.answer) {
    await replyToMessage({
      roomId,
      toAccountId: senderId,
      toMessageId: messageId,
      body: `${result.answer}\n\n（Q&A表 ${result.rowNumber}行目を参照）`,
    });
    log(`即答しました（行${result.rowNumber}）: ${question}`);
    return;
  }

  const askerName = await resolveMemberName(roomId, senderId);
  const mentions = config.holderAccountIds.map((id) => mentionTag(id)).join(' ');
  const holderMsg = await sendMessage(
    `${mentions}\nお客様から以下の質問がありました。Q&A表に無い内容のため、ご確認をお願いします。\n` +
      `このメッセージに「返信」機能で回答いただくと、お客様への回答とQ&A表への登録を自動で行います。\n\n` +
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

  await replyToMessage({
    roomId,
    toAccountId: senderId,
    toMessageId: messageId,
    body: `ただいま担当者に確認しております。少々お待ちください。`,
  });
  log(`ホルダーへエスカレーションしました: ${question}`);
}

async function handleHolderReply({ replyTarget, body, senderId, roomId, log }) {
  const pending = await listPendingRows();
  const target = pending.find(
    (p) => p.status === 'pending' && String(p.holderRequestMessageId) === String(replyTarget.toMessageId)
  );
  if (!target) return false;

  const answer = stripChatworkTags(body);
  if (!answer) return false;

  const holderName = await resolveMemberName(roomId, senderId);

  await replyToMessage({
    roomId,
    toAccountId: target.askerAccountId,
    toMessageId: target.questionMessageId,
    body: `お待たせいたしました。ご質問について回答いたします。\n\n${answer}`,
  });

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

app.get('/', (req, res) => {
  res.send('Chatwork Q&A Bot is running.');
});

app.listen(config.port, () => {
  console.log(`Chatwork Q&A Bot listening on port ${config.port}`);
});
