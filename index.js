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
