import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import fetch from 'node-fetch';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import holiday_jp from 'japanese-holidays';
import * as webpush from 'web-push';

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

  // ブラウザのプッシュ通知(質問受付ページを閉じていても回答に気づけるようにする機能)用。
  // VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY は webpush.generateVAPIDKeys() で生成した鍵ペア。
  // VAPID_SUBJECT は「連絡先」としてプッシュ配信サービスに送られる値(mailto:アドレス
  // またはhttps://のURL)。未設定の場合、プッシュ通知の送信はスキップされる(エラーには
  // ならず、サイト自体は通常どおり動く)。
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || '',
  pushSheetName: process.env.PUSH_SHEET_NAME || 'Bot_PushSubscriptions',

  // 接客担当スタッフの名前とChatworkアカウントIDの一覧を保存するシート。
  staffSheetName: process.env.STAFF_SHEET_NAME || 'Bot_Staff',
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
// ブラウザのプッシュ通知(質問受付ページを閉じていても回答に気づける機能)の購読先管理
// ============================================================
const PUSH_HEADERS = ['エンドポイント', 'p256dh', 'auth', '登録日時'];

async function ensurePushSheetExists() {
  const title = config.pushSheetName;
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
      requestBody: { values: [PUSH_HEADERS] },
    });
  }
}

async function listPushSubscriptionRows() {
  await ensurePushSheetExists();
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${config.pushSheetName}`,
  });
  const values = res.data.values || [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[0]) continue;
    rows.push({
      sheetRowNumber: i + 1,
      endpoint: r[0],
      p256dh: r[1] || '',
      auth: r[2] || '',
      createdAt: r[3] || '',
    });
  }
  return rows;
}

// 同じ端末・ブラウザから何度も登録されても重複して保存しないよう、endpoint
// (購読ごとに割り振られる一意なURL)が既にあれば何もしない。
async function appendPushSubscriptionRow(subscription) {
  if (!subscription || !subscription.endpoint) return;
  await ensurePushSheetExists();
  const existing = await listPushSubscriptionRows();
  if (existing.some((r) => r.endpoint === subscription.endpoint)) {
    return;
  }
  const sheets = await getSheets();
  const now = new Date().toISOString();
  const row = [
    subscription.endpoint,
    (subscription.keys && subscription.keys.p256dh) || '',
    (subscription.keys && subscription.keys.auth) || '',
    now,
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${config.pushSheetName}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// 期限切れ(410 Gone等)になった購読をシートから削除する。行番号がずれないよう、
// 末尾の行から順に削除する。
async function removePushSubscriptionRows(sheetRowNumbers) {
  if (!sheetRowNumbers || sheetRowNumbers.length === 0) return;
  const sheets = await getSheets();
  const tabs = await listAllSheetTabs();
  const tab = tabs.find((t) => t.title === config.pushSheetName);
  if (!tab) return;
  const sorted = [...new Set(sheetRowNumbers)].sort((a, b) => b - a);
  const requests = sorted.map((rowNumber) => ({
    deleteDimension: {
      range: {
        sheetId: Number(tab.gid),
        dimension: 'ROWS',
        startIndex: rowNumber - 1,
        endIndex: rowNumber,
      },
    },
  }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheetId,
    requestBody: { requests },
  });
}

let webpushConfigured = false;
function ensureWebpushConfigured() {
  if (webpushConfigured) return true;
  if (!config.vapidPublicKey || !config.vapidPrivateKey || !config.vapidSubject) return false;
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  webpushConfigured = true;
  return true;
}

// 保存済みの購読(＝通知を有効にした質問受付ページ全員)にプッシュ通知を送る。
// タブやブラウザを閉じていても端末に通知が届く。期限切れの購読は自動で削除する。
async function sendPushToAllSubscribers(payload) {
  if (!ensureWebpushConfigured()) {
    console.error('VAPID鍵(VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT)が未設定のため、プッシュ通知を送れません。');
    return;
  }
  let subs;
  try {
    subs = await listPushSubscriptionRows();
  } catch (e) {
    console.error('プッシュ購読一覧の取得に失敗しました:', e);
    return;
  }
  const expired = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
      } catch (e) {
        const statusCode = e && e.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          expired.push(sub.sheetRowNumber);
        } else {
          console.error('プッシュ通知の送信に失敗しました:', e && e.message ? e.message : e);
        }
      }
    })
  );
  if (expired.length > 0) {
    try {
      await removePushSubscriptionRows(expired);
    } catch (e) {
      console.error('期限切れプッシュ購読の削除に失敗しました:', e);
    }
  }
}

// ============================================================
// 接客担当スタッフの一覧(質問受付ページで名前を選んでもらい、回答が来たときに
// Chatworkでその人にTOを付けて通知するために使う)。サイト内から追加・削除できる。
// ============================================================
const STAFF_HEADERS = ['名前', 'ChatworkアカウントID'];

async function ensureStaffSheetExists() {
  const title = config.staffSheetName;
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
      requestBody: { values: [STAFF_HEADERS] },
    });
  }
}

async function listStaffMembers() {
  await ensureStaffSheetExists();
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${config.staffSheetName}`,
  });
  const values = res.data.values || [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[1]) continue; // アカウントIDが無い行は無視
    rows.push({
      sheetRowNumber: i + 1,
      name: r[0] || '',
      accountId: String(r[1]).trim(),
    });
  }
  return rows;
}

// 同じアカウントIDが既にあれば名前だけ更新し、無ければ新しい行を追加する。
async function upsertStaffMember(name, accountId) {
  await ensureStaffSheetExists();
  const sheets = await getSheets();
  const existing = await listStaffMembers();
  const match = existing.find((r) => r.accountId === accountId);
  if (match) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${config.staffSheetName}!A${match.sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[name]] },
    });
    return;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${config.staffSheetName}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[name, accountId]] },
  });
}

async function removeStaffMember(accountId) {
  const sheets = await getSheets();
  const existing = await listStaffMembers();
  const match = existing.find((r) => r.accountId === accountId);
  if (!match) return;
  const tabs = await listAllSheetTabs();
  const tab = tabs.find((t) => t.title === config.staffSheetName);
  if (!tab) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: Number(tab.gid),
            dimension: 'ROWS',
            startIndex: match.sheetRowNumber - 1,
            endIndex: match.sheetRowNumber,
          },
        },
      }],
    },
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
        // こちらも固定の環境変数ではなく、サイト内の「担当者」一覧(Bot_Staff)
        // 全員にTOを付けて催促する。
        const staffMembers = await listStaffMembers();
        const mentions = staffMembers.map((s) => mentionTag(s.accountId, s.name)).join(' ');
        const mentionPrefix = mentions ? `${mentions}\n` : '';
        await sendMessage(
          mentionPrefix
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

// 担当者一覧(Bot_Staff)は接客担当ページ・プロモーターページの両方から
// 追加・削除・閲覧できるようにするため、どちらのパスワードでも通す。
function checkChatOrPromoterPassword(req) {
  return checkChatPassword(req) || checkPromoterPassword(req);
}

function buildChatPageHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="data:image/png;base64,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">
<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,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">
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
  .push-enable-btn {
    border: none;
    background: rgba(255,255,255,0.22);
    color: #fff;
    font-size: 10.5px;
    font-weight: 700;
    border-radius: 8px;
    padding: 6px 9px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition: transform 0.1s ease, background 0.2s ease;
    flex-shrink: 0;
  }
  .push-enable-btn:hover { background: rgba(255,255,255,0.32); transform: scale(1.03); }
  .push-enable-btn:active { transform: scale(0.96); }
  .push-enable-btn:disabled { cursor: default; }
  .push-enable-btn.push-on { background: rgba(255,255,255,0.14); }
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

  .staff-indicator-btn {
    border: none;
    background: rgba(255,255,255,0.22);
    color: #fff;
    font-size: 10.5px;
    font-weight: 700;
    border-radius: 8px;
    padding: 6px 9px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition: transform 0.1s ease, background 0.2s ease;
    flex-shrink: 0;
  }
  .staff-indicator-btn:hover { background: rgba(255,255,255,0.32); transform: scale(1.03); }
  .staff-indicator-btn:active { transform: scale(0.96); }

  .gate-card select {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid #dfe2ec;
    border-radius: 10px;
    font-size: 16px;
    margin-bottom: 12px;
    font-family: inherit;
    background: #fff;
    color: var(--text);
  }
  .staff-gate-card { max-width: 400px; }
  #staffPickSection { margin-bottom: 4px; }
  /* 「.gate-card button」より詳しいセレクタにして、ボタンの共通スタイル(幅100%の
     青いボタン)に上書きされて見た目が崩れないようにする。 */
  .gate-card .staff-manage-link {
    display: block;
    width: auto;
    margin: 10px auto 0;
    padding: 4px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--muted);
    text-decoration: underline;
    text-align: center;
    cursor: pointer;
    background: none;
    border: none;
    font-family: inherit;
  }
  .staff-manage-box {
    display: none;
    text-align: left;
    border-top: 1px solid #eef1f6;
    margin-top: 14px;
    padding-top: 16px;
  }
  .staff-manage-box.open { display: block; }
  .staff-manage-box h4 { font-size: 13px; margin: 0 0 10px; color: var(--text); }
  .staff-manage-list { list-style: none; margin: 0 0 16px; padding: 0; max-height: 160px; overflow-y: auto; }
  .staff-manage-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid #f3f4f8;
    font-size: 13px;
  }
  .staff-manage-list li span { overflow-wrap: anywhere; }
  .staff-manage-list li .staff-del-btn {
    border: none;
    background: #fdecea;
    color: #d1403a;
    font-size: 11px;
    font-weight: 700;
    border-radius: 7px;
    padding: 5px 9px;
    cursor: pointer;
    font-family: inherit;
    width: auto;
    flex-shrink: 0;
  }
  .staff-manage-empty { font-size: 13px; color: var(--muted); margin: 0 0 16px; line-height: 1.6; }
  .staff-add-row { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
  .staff-add-row input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid #dfe2ec;
    border-radius: 10px;
    font-size: 15px;
    font-family: inherit;
    margin-bottom: 0;
  }
  .gate-card .staff-add-btn { margin-top: 2px; }
  .staff-add-hint { font-size: 11.5px; color: var(--muted); margin: 6px 0 0; line-height: 1.5; }
  .staff-gate-error { color: #d1403a; font-size: 12.5px; margin-top: 8px; min-height: 16px; }
</style>
</head>
<body>
<div class="app">
  <div class="top-bar">
    <div class="top-bar-inner">
      <img class="brand-logo" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAACRaElEQVR42u29ebxdZXU+/qz33fuMd8qckIRAmAOCgkDC4A0gAgpqay+1/drJarW1tbX91rbWNqbjt/PP2qrVqlWrVa6tYpUZIQokTCoCYUoCJCEJme58zzl77/ddvz/2cNZ+974hYRIwh08+Ifees88e3vWutZ71rGcRDr8O/sWgoeEhtXvebpq/Zz4PXzlsyt52wjfO6Z3XDOYtUJVjLWFeneikkYibCrzCJ+o3gOpYLBsJudcjJssgy4CvAQVgOgIqCqgosCIyzDzma9pWIyKAd41E2FxTmGh6+gGfzP4d09jUr/p3XffG6zpl5zN4y6AHAKtXr7ZraS0D4MMP8+BedPgWHPi1Zg3UrasHVZlB3MKD3se/a5fW2Jy0o4MTQ8un9vk4YTLCwo7F/JpPDfYIVY8QMtCOGGDAWKATWigGCAwiAjNgAfgU/205/rmi+CmRR9AgMAFKE3wAihkcMtjaiYZWu5j5qQnDG4+pqQdCVhu3d+jR2y773k7XGoauGtIAMDw0bEGHjeWwgRziPVnDa+jWW29V6y5YZ+Rue/k9ZzQmnlYrahXvnMDinI7F6XWNI6OKrlod38ootLCGEYUMY5gBcMTMRIAGiJMVqQBigDTFX6AIYC5u7QzAMJgAJop/kNgTCCANKNIE7SlAE8gD+jyF6ZZB1DGTBHqkTvh+xcMGVurOlcp7ZO0F6yJ3A1h96zq7di3s4cd/2EDKPQVD3XrroFonFg8ADN18zgmTjAvAuGja2LNIqSOjmkLHAhxYRBHDRNZqgmUCFJNCvNiJCaQBGGQL+4Avm76HAabuw1GJoSRGAULsZdL/B4OJwAbMxGCAoAgKmpT2FTyfUCUgmIoMiB7pV3Sb1XQ9PLX++sHv7ZQh5OCtg/qwsRw2kNyCWLd6nZGhxuU3rjozBN6kiC4NLF4T1VQlsEDYsTChBTNHDICIlAKIKM4h5K5P6aJOFj0lBsAAEmeTLXSI91thSMzxezURIubsPen7FcXvBygJybq/o/jzbAEmsFVEZABdqyn4FQ2PGaZlxljhzhpwTc3i+m9duv5huWFsHB6in/QwjH4yvcUatXF4I8mc4i23nPPqyNIVBvzWyOJ0U9eY6liEbQPFMCZe9qTiDT2OeVgYgliYigDD+d1eGg0Jw1HJ79O/bWIUhuOfpTlIlLgMSmOr5DOUeKj02NLbyGMnK5wJYEWxHfpaaVVVcZw2bUJF2DBQoWGyuOYbF92xOfOiPKSHPzLM+An0KvSThkDJHfH8a89fVPfMWxXh7dOGzzN1T0WBRbtloAmRZVYAkSIQJbu1FYsv8wBisRvHhZAIlWzJzVcAIk4MwfEg5MBNJF0Uku+krmeS7zPimK6H0sm5AuAIbInBTOT5dY1GRYGmo+mKVjdVtP3iiUHPtf9wyY1TueR+BvTusIG8nA1DPNQLbl51Dln8cifC26ipZ3dChu5YdKyNAFKWodKFLT2EXHxy94eTG7Cz4NNEXN5wO4MBpJ5FeqTUGyH9TuFFdBZmxf8fcfG4MpwjGcKJ87OceBZm9jwVGwsBqmO2dICvVir+525a/d3HZrqnhw3k5WgYGFLDFD/Ez90yWPuaNVdEbN/XBgYDX6EzbcDGGiKAmFQUI6u5xSl3dU5WXbr4jfAQqVGws/CtMBZpOOwgVUi8AIk4TJ5DlBqacw7yPDzhTcpCLBmCyZ+lBkYAPEUgZmbARgyq1ZTyqhpe27R6Na7u8/gTXx5c/10JGb+SDYVe6YYx+PXTBrye5i8AeK+tqBUTESOcNgywBUhpAkVOOMIlN0c5uYTc2d1FbYXhELq7OgnDUt0wJzum9CxKGpnwAArF80wNIxKeJMWBM0MRoZVBMfSS/07DyeQcrGG2WpHX0+NBR4wg5O/UNf755ovvuPqVbiivKAORD2nw66cNhI3mOxn8W35dHxV0LNptYy2BwaTlzi/zBJQgS+nvdLLCI7Hlskiq07wg9RQSjs08kXNgcha/cYwrrY1olQ+lDHe9kwyfIP6tqOuZrDBSN1eiEgg5/YEHIGTAoxgUCy2pRo+mCgAd8R2tiP/prjeu/+8YbH7lhV70SjOMoVsGe8ZM9K6Q7fuDqj66NW1gQmsUESmCSheWaxS5BcLFeN81mEJBLzmmBsFwPhGgZEFryhuc/CyEYbFjbC58a51ztiLskseX7wV3jcY1Si7xKIyiEXM3TDTMIF3XShPQYL6jV+Fv//fC2KMMXTWkhx98ZaBe9ApKwOn1N6x6h++pP2776oRW26DdNoaICIDiZEF4MowROz+L0MaWLLB0d3fjf9e4IFAp+TNZE3ENgxwjyxmI85DkOWnKL36JVHmUBxekMaXnJhEwLkHPlPyccy2WAZ2cit/Qqs8j+JG9vmXsX9/6hg3rUg6Yy0Y4bCAvltfgIZ3mGW+55dzV+43988jT5wWBRdgxRhERM5REkCAWRbqjp+GEFguKHZjWXdhUhmo5O751EuKyxJxF5bwseTciMVckPIdwUGWeUP4j3QTSnMcI78glyBYdYDVLlI7EMZjZaiJUm1rpiDHg4QuexZ+ltZSXc37y8jOQNcl6Wwv7huteuzTSlbVK0a+MA+hMR4aISBMpw5ztpLYE1bFOdkxllA8Uk26ULUanQu4ehw9Q01BJjK8pD/Hmzl0aMHe5W+QYtKyTuGhcluOIHCZXvxEonJtDoQRxAxUNn5mNAqnefp8qgRkxzH+7beOef9r025s6Q1cN6ZdjVf5lZSCJy44A4NLvrPo1QP15y1fzx0dDNsTWA2l2YnJFCQ1DoFByxcrkV8KytgTCJcpDohblATxR3sggFnVZPUTmHiSOJdEnU/LgymomEJQWoqJxyfqMNLI0fPRU1wjJzXOoyCnLHSe7Z2yUVrrZ46Eemu9XwR+8+sL1N78cvQm97LzGLatODCL6R7+mL5uYNmgHxmgibWdAoVBC8LMC+lRUDBvgeBx20J5cKCIWcCE5lp8rqaUQ8rCvu1NLWoqi/M9czpcWuUGuToP8glYCNMidE+WJkSkCZp2Q0M3BykAHTQS2zEQwuq69fgBg+zHeH/zJTVfeO5YYiX055Cb0ckKoLrxp1fsM6C87WvW3J0NDIMUUP387Q+1AlfCgTPpzgR7JRSsTc8hCmrOYpLXIpNZ1E2VJuBvzm5JdOyYqJhQXYcySoiK9hAzpWNZEUAyduCREJGEkqcfQ4n5Y93ukl3XuWRcJY8sgavZ7VAnsw1XLv3P9G9ZfnxIi19JLG+l6KRsIDd4yqNddsC46/7rzl1a86F+46r1530QEGGtApJWDquS8hgONGlk95nzCLt/PmHmbJnJjblEkRL4Szigm9ukCUhTnHWGyNHwCej1Cj44DdAPGaMiYNAwFgkdFCNdFpSQiB9egnfqH9KiyhlOWi8k+FclKdj1eznsmJycNSoEjv6a9BhF84r8Z2Df6p8NXbgxk2HzYQA4lpPoIGAQ+59qz31zx9Cc7vloUTkYm5LgRT1M5rbxQXxCxv3XQIu3s3FRSRyDBsvWo+/+qxKDI4WpREm6ElqEJ8IjQtozAMmb5Csc0FE7u0TimoTG/QqiquPNQAZg0jMdbBneORnh4ymIiYlRUOblRUTGvkUarxS5vS0JBcj2EuCYW1+32rJCTU1HJ5sG5hJ6tZaLeAZ8agdkwG/Sur1x0+4Mv5ZCLXrIhFYMuuOmcv+4o+oMgYoSBMYriJNwt2MkkNYvrSwprqgRCtc7u+ExhF5U4GHaq3xIpI8SGwWC0DNDvEVYNeLhwjodFVQVfEQwDEXP2nen3ViiOP7a1LW7cG+KO0RCB7dY4pGd086q0HuPNgEa5G4tMzOFCxw7CpVU3v2EHOXO9iHu/YsSMo0rD8+qWx2uwv3XDxRu+AAbhI6CXWnGRXooo1SXXnrGooytfMHXv9ZNjcSBiAVUW5qhie2ou7oZ4uKpkhzMM+KpLxZBQqkxIyxqaSusGYjVo8aOAgfMHPLx1QQWLawqhZXRsMVehkrCxqoCKImycNPjyjg4em7aoqiIB0WbV/CLq5YaKklumkEfyiMqviZw6TBpGqTIPVcIGyAElHCNdvQ0N3TH/8htjS37nyiuHzUsN5aKXmnGc962zz1ZV/dWOp5ZNT4SRJvJIPAgW4ZGdIV3ADLulW9dwaSLK8T4sFgNRMTxhAekqBylKd++QgR5N+IXFVZzd74HBCGwexcIznH+KpNU1EFjgC091cPO+CD1efHyULFxdUv2W36MlQieMwhOF1AyWngHaLWUIlOQ/0jN5yc8jAGTBrGBn9fua2+Y7o+P8cz962/rdL6W8hF4KdBEMDylcOWwuum7l/wm1+vQ0ox51TAQiDzMgMGmY5FH+YdiS97ouf6ZqcYFScYCF4S5oQhxGyaS5Y4A5PuH3jq5heUNjIuKcYZQVDg9k8Kl3rCnCp7e38Z19ERo6bsedycAsxxT29AaZksKjbPElmrkwWrYB2JLCKDkMaFnB96nr6b2s9sNRpcf3ahFvNh1++7o33XHPS8VI6MduHPHasm++6Zw/HiP6i4mOhTVsFXX5U3iGLjsZQ7sNSjKRzsG0YjGkO72sXCtBMCxUx5PQK10kcAwrRYvm+QofOLqGI6oKLcOFY6EEggaKSJlrlJyEXf/8RAcbRiPUtdOE5ZAt3SJlVq8QBiONsizvwgHAEJTwtpDcm6gM5nZhdADEbGp1T9eIR/uY3/3N16//2kvBSNSPFakiMAh21bWr/nmirv9iom2sNcyKoKxIGhXlaxpcskvKnCGFLS13H36GeokYSVNcRDFODYPE98nzyBarCEfQJe7Fv8/8CfDOJVUcWVOYPoBxzLRTkbj2wvuSEOhXllSxoEoZS1chT2l3cyj3wUsgA0J+yG0PzuowyDd/uRuWcij9IZeDAunnba6gSjpoRXYq5IE9oOGzv332u9ddsC4aumpIJxvpT5AHieF9e/k3z2h0mrUvjGt628R4GPlEWhFItphSyS7mhl0F/L7sKyWmT93Ks2sUEsYE5ZPXXD3DISSmH/EIaFvgojk+3rWkivGIc6gTDjLvmMmI5C7dUMC6kQif2tZBXcUezZZ4HZdkiBko/LasN/4AzGJpKO49SRvFJGfLul2XnO9bSTY362tCva7VQGT+6lsXr//jNbxGrcVa/nHwuNSPQ1EEBHvWNWf1tRuVb7cr6m2tiTCqKvKIQOkN02KnSmNWt6BFbg+Hc2FKhBKS2p3jLDkJJ4kdNF0kaU4heVLM3XNjUW8wDPRqwhvmeAgsl4Y2z7x/FPvgy/KmaQOc3e/h6LpCyPlaj5sHsGD0uvcA3M1L5AaQeiMqybvk/dbUBTFY0FPcIqr0PjkKjNABUwTFlmliOjIjNe9Dg9et/Je1tNauwRr6cXiSF9dAroJeS2vtGVed0V/V+lvtil49PhJEROSR4x2MCI1y4YbTv5Aj5qHYF0GiGKgpbwxlsb0MHZSgYZS9XwlqRrojThvgxB6NJTWNjhVhTxkd/RDdOpU8uLoiDM72EdicWsmM3ZHWuY4stxPFVAl1u/UQl2YvDSPzNpzvnZFcMRdGTg1Q5RvBSDF0ayyMTNN/36U3rvrEj8tI1IvqOa6EOe3rpw1U+irfNjV9/vhoGJGKjSNKdx/Oew1JHSEZU9MB4MSSh5jb7TlfXOTkoSqHPm6dVSmRMJQwe1OjOb1PH9Ti54MwBirpIZGLO7CME5saPR5lSJH0lGnuQE4ompIVlXN/4EigUpJPuV5HzXDCimJvIDcOV8TCrWMxl8PHALzpsTAKGt57L7z+nH+LjQQvqpGoFyshX0tr7bKvDw7M6Wl+G3V97tRYGCnVhXFTb6FKeiWshHCdHRmpEkeyS9EMpDkSu1zuIaRwJ+U9UU6MIUWulFBI5Dy1I4UymxpYXteImGdWMJlh8eMAohFu4TJ9RQAWVglH1VQcJonwyEi2snPftGD8yuPrgpoKFwqI6TEzhNEJPSUNxZYQMNUMlXypPZbeV8Pw9uwPIvToX7viplWfWkuwQ8NQL5aRqBeLVzV0y2DP0c3gm62KOmdyLPYc0lu4dAhyVggLD+MyZKOkOcrdYeG4dZmYyp2LneMVdvf0Ydu8F2MqdhYOeIS+RM0dB1j07LJeZwi/LM+QHIu/K4qwpKbQ4TwK5cb8tkQcW/bASy8pWQhpnlKW50maPORnS3pUrNN74ib66fN1ES8N8vbvD6Pxmvfu1dev+tTwlTAYHlIvBsikXvg6R+wUJ034lajund8eDyOtyMsQlURO00WlFBWLWDLmt66gAuXDqoi7iTSJZDS3o0r5UMm9ouLiZI5ndkhlEXLyHQBoelToR6cDhFYu2FCIXOgZCojJ+S+sqnyIyEWoVwIG1j12SWGQqMh3k2FRWT7DogAoPX+am7jdmoVn54pEdL2Wt39/EIUN791vvPGcf8KVw2bwlkH9QhuJeqGFobF2rT33mpWf2++rN42NBBEp8tiBcNkVB3AWu0f53MOKB6+T6qzkL1nxmfRzuqThyEWI2Fl07gKKRA5iROiVVZApjtk9mtkj8EE+0bJdmEuMC2X1DsojYS7Ll5zrVrKomBhW2gKc67d3qDgSDrYO1Ksp7k4kJ08h5KWI0nPV1EXTciFf6nUAKCJvfDSIWnX9O5dcv/KP1l2wLkqM5OVnIGd86oyYW3XNyj+nPv+XW+NhpCgOq9zdkpx+6jKpf3fxekktI7Dxn9RtV5KHEjLQsaLA5aiqs8hBCnUGynffZYbgLKoCOZKLKiIzJd8HCqvoAIXDss8wgLbl5Nwp2xCsc95liY4bUsrcQVGXypP+TgtD8BLDimz8RwHwKQYL0n6XAhopogaZ42WbpqylUBdmT9dJhUiPjIXRVMX7q8Frzv71xEi8F2odey8g8TC85NqV752oeR+eHAmieLSL0/nndtGVJHmyWUe655Twt6CisLSm4oYjL3mARNgfWuwLGE+1LcYSyUGf8shYrtjnIF1EbhupgItnaJPVBExFFtOGM1TpYFGqg/UsMxEcxyKGBWcLNZdUuyMTHM9jOF/MKzSGObBxCkhYALN9haU1Qk0RltYUCMBIyJi2jH0h44lW0stCRbUXeUG2TOibHa3hmLpCZKE7bWMrvv6Xi685Z/ONF6y74YViAdML1c9x4bfPvthW9TWjHVbGMKn43uU0mwjFNlG3hRPoNh5pilUNAwaOqsfNRnN8lS3egDljqcahF6FlGE91LH4wbjAWMWqq6220WzwURuLS6GWlvcADE+xYj4APH1PH0lpcvDvYcIqedSQb87L+dksbP5owWZ6kKc9NM2VFVcpvUnDQKJWEr5EQxQuZETFwZE3hhKbG/IpCUwNTllEhQscyPCJUVfeZPNGy+NGEyVgFLiNAzkKxKAdO3H4UYlh4RLN9GlMhr7rh0vUPvxBGQs87YrUWdvDas4+Cp++atpjX6VirFZQtY+c5xDjrkAOtiEOJYpc9r6JwRp/GwpqKXbmNHxgDqKtuhZkEc7SmYo7CXaMRNk6Z7Hili12cn3IKkXDbcx2D9giYMsD7l9Vw7oCHKcMH1Pzlg/AMz2QcGnEo+ZHNLexqW1RU93wNl9NKXA/GZTQQcd/T37UNML+qcHqfxhFVhSBlCNv4WdVUnn9lGajpeHMbDxn3jkd4vGVzHDa3SOj2yJMjopHLeyzbesNTXmQf6rVm5XWX3TWRXBS/9HIQBuHkIVp2y2CNlfpqR6t5YWCMUl00MOVBwYn/jUQ83IIeA74ihBY4uqHwhrk+5lUVIsvoWEZFEXxBTbFJHpIahUeEwMYw8MoBD6f26qwomaOQkJOTUD73IZEIuLmKyw97bMrMuLpphgR8pvfxgegoyb3Z3DLY1bGxZI/DOpaJMpUU7ozTQ+7Wd9IwMbDAsU2NS+Z6WFxVSehDiJIKfjV5yirx9LFni59byzCqinDBHB+n9epcm4JCN6eU4bUkX7LDiMgWryIVtiODuj6po/UXiMBDw0PPa43keTOQwVsHNa4cNss7wceCuj4rmAojJC2yuZ2SixBiCq1yiWCAR/ENPrlH49wBH6FlTEaciS+HiUuPoV3KdnJOjmaYYZOC16RhnNHn4cw+ndHbUQJxKodN63KW3N1MJue+An4wYTAS5hcsnoG5yzPM9DiYHObO0ahQ8Ev/P+K80bBT3MuMhvOoHwt6TssCr+rROG/AQ2SBlmUwGMzxwk89UJSEuIa7yXy3BZoxHTFO6/WwokejZbvImUWRmpJDs1ztL8pJDOmp8TCyTe8tF123cs3wlcNm8NbnD9lSz5cM6LoL1kUXXbPyl1o1/a7OeBRx0uwELiqNpAvNLTxpR09WE9DheOdaNeAhTObwyTg7rfZyIi+ejgEIrchd0EW4Qmas6PGwrK7iRN/pjwCXhz6pBA85sKmEV6OkfXdXx2L9SIQqUa44RyWExAPBwTMxk9PFXlXA1rbBXWMGDZ2ncjizCvPhIOVrN6Bi9Jvu4IEFTu3VeG1/fP/Tn0cce5+QOeG4UTJ+gQvXYRmoJMbXtoyVAx6WVFVeUMKBn4nKQ1I39Iy/k/TEeGhavv7I+f+76pKMJv88vPTzwbH6OH3cvvbac07wffX16cD6sMj0qpRIbrUMYyjfQpuzVuo2MS2qKlww28e44Qxm1ETZ7uipfKhWVZRTMQ9T9USJ4VN83C3TBpEjluaKNrtEPneuIFz2a/JnX8Q4q9/r5gTP4B3K/n2gRDENYf7jqQCbpy18yu+u5LCRC3R+R/xa7tZa8LWW1hTOGfARguEnuKt24FdPESw4JyXErkh4Eu6m9ZUFyf034h5rt0PRlToV72GxQVoC2aSA5nl4/Uk/f/SXv/mWaycAKKx7bvmIeq55x8bhjXQLD3pN4s+PK/TGwvhZJJWEN90bxqKxKFf74C45UO7ar+3XsBwn3N2kkcXuQ5k7jo2KM+o3Ozt8twZDqClgRY+H0DpcLeSpFVxCizcltRTrFMmeaBlcvTtAXVOBWjFTvweeoW7CgtLS6xG+NxJiw2jcm26dLkQrKP6ppzBcPhohR2kXCbKv4rzNCMiVk5DVJl6a0VVkkaJ2BnlmQnr4MKlbNTRwfFPHEkbiuuDQ8MlZE6Eteqfk2agoMDaq6EXTCP8dBB46eYieKxD1nDzI4OpB75rLrzE7Vy1aGzT9n+9MhBGIPCkGAOr2C5RRGDBD51vEwMk9Gif1aIxHcTLefaCEiqLM8Pzk4CTygDRBV0QIbDd5V5TM7wDQ4xG2tkwMx5bQHyzy/SAuciVjAJdW7xHhsWmLeRXCcc2E+k4HVxTEARq+okQEYnPL4GNPdnK0GJSEqER5ZoLbl08l9H2iWIXlpKbG0XWNjmVUk+1aJd6bk/vZSWSIkFxzhG7vOVGi8+V0K8YbCaFPE7a1bTd/ojyiqMr640taDrrMblKdjomqvf4JJ//sEfuufssNdw5dNaQ3Dm/kF92DDF0V5x0XX7/y3JanPtSaCI1FV7fKTfbkbksllA5ZOFSJN1hWV2gboKljF57u6KHlLBHUieYUJXFwfqdk2CSRTCHfUATpcyqEI2oKgePRuCQnctm0uU46GbdTXmjuk9s6uGs0Ql9SOLSH0DDlkgpT49jRsfjnJ9toW87NKJQKJVqgcOwQNDPGLDvkTWFUHoBjGzoTqUvEFRAIUCRkoJp4SGO7CzqwqXFwMpErfm9guxJIHcvo8wlH1eP7z+L82BHgtoJXx+ysL0GUjCME0lNTxk5o9f8uv27VicNXDps1/OzXuXq2odWKoRU8eMtgrWXxyWmQSuA+siV0C4U8bVzCppaLYtARd6U42wmcS4ln6D50hibKqrqhjRe/XMht28XlPSL4SQ96+kACG+ci2k2IqehiZYgGztMgMuarMxgnfX1qWwfr9odoepRTc+SDCLEk+7XfIzw8ZfB3j7exL2DUtaPzS93zYIe241Lm5cbEJXpcPR6h3yN0kosJk93NU3EPSmw4lIiVxXBzxN1CYJRsTEiS+Qp1cxA/4WlZZsxPSJbKkY+V+aCknZDDPnY7IBXFI74CTc0O4ZNrGGrj8BC9qAYyNDyk1tJaWwmCP0HTPyVqRSZB+Ao9HeyImLnxuKwlaKExW9cEX6XhSr7inVZ3I+YM2aqJPtMUU28oSm40A8Ro27gZvq66C6HXo5i/JaFEnqHa7fSMuBymSOQtEt8PmPHJbR18amsbk4bj7xTAgvxjRdNYCmz0eXFY883dAf7flhZ2B3FBMM0Bcg1MVDLLg4sVaTgzEI0T3vZ5JEJhhp9UxrNwNmE1dBUWY5oLiUXdNrFcqp8REjm7V37iSWZ5hIYWwhNUnPzrNovliJMCJhbidDqcjqKw4Q3edf3K3xhOBOlelEr6Gl6j1tJae941Z5/Kvr57KrQaNte0VmjcJ+SV9eDI8FjRTIOkMryiR+PsAQ8d0+3rdoWWk14BWHCCcFBWWa+qbq4RJjBj/Hf8/vQwk4Zx096wIMDmzvxze7Hduo12roWdWoplYMowFlYVVg14MdRZU7Fhi41DwpyhBfaFMU3jpn0hNk8bNJObJAuqvuouduNOx0KJ8LYzZYqFknvqeY9vaJzV78X0HerSg4zT854+Y6n4nsqmBjFek2x6sUeZjLjQhnvt3jD7OUp6g1gqRjrC4BLud0Q8WPvEVWDS93DqLReu35pKTL2gZMWNwxsJDKpcRx8bU1Rhw4aIqIyBq0oKOyiR5/GcqrVcKFGyqNOJUTI3SHez0KaGyKhrguJ4Z4tdeyzplibpJuESUa7nhECi6UqLzja3xbVs0hJzXsaT5dxAERL0aMJYyLj66RA374uwrK5wbENhlq8w1489WcTA/oCxL7J4smXx+LTFvtCiqqibxzij2zIlROmRnc7IHLnSoXDYZIhjmNwvy5yFjx7ywIYcMZ3WnDTFTVuchFupoXqJYUQ28VA29ihti0yI26c4P7Ql47UhKDwWJWIQ1D0fTYClXG2HTGCt7vX7Kq3oH0D4maGrhtQwhvGCGUhKBjv3mlXvDHv068xYaFQyvIadnYUdxis705uyOggXpTwBYDpRQU+pNUrsioGNd00Dzh5EkNykkLkb3iSVdEUUw5Oc90RxXkMZbOwyi91dkcv6r0sG11hHiytXW6EY4oyY8fCUwf0TsbRahfLGZjnJsQiZ14gcgQqUqITIjUdC0YqKItNud2ZKBqUkPEoXYmTjDaauCAacq3N42fOMY+xORl/nbv6J1FjiPMQjznJHnaBdloU8UskgUyWvPw1jRdOdccUBY1RLdyYjoxr6bedfu+pNw5cNf/tQCY3qkBLzB4f5ohvPnEMKf9ZuW8sgclGrgnYUC0y7pB8jR6oTcfu0iXcueYPqOl4wnupSrv2kglsRFdkYLeFsV484Zpr6quvVfKET2xGttLpE2XwmiroV16Ao7/7J6QWXk2nTeL+azAXp84CaJlQpJvc1dWwUNR2fpxX5iQzKy0YOpHmARrnAHpwquqK88StR8Xab0gJR7whs14OlG06H84N/IJCr9DkpYlRFZ2bHMjrG0Q7jfCEyE+UWELV2eHzsCA2KTlLqxObwtx+4Y2V9+MFhPhSuljqkxHwtrDXeB3WPtziIoSUlKcmZflU6ORX5C4VzIXJ2HxxFv8AyxpM+jjQkmrYMZspk/72EXq2T/MMI1+4u6Ig5o590RzoT9gQ2D98KxY+ymo0iWXDM62NpQbiTxD9ymagCvEjPuWMZURIudmxe7VEnRbu4jlP00lQyIz1yNp3CUCGhEOm2M6es5MjmRzJ4lFJ3KANFJEBBmQYZ5bhpMfTdTfQZBAOgkaCUAedZz6BivhfKOe+U94zKQRRtnjqvorYx6PFW3DtG78Za2EPhah3UG9esgfr4+zbyr7z+vOUjhj870bKeBKvYGWBJougjHwiVjGSWya+kukcMLKgSZiU93tkOTYACJflHl95gRM7iZSEQJY1S8QOpJrM4UndfUYRHpi32Bpw9CLngFBVlc+DQMTLahpr5gQU2NoAw2WWR7CwasaeoJ38aSkGrrmEEHP9pW0Zo44KnESGbEkXYlDKdK65RiSaxw2CAQ9hM0aC2BZbUFJqJAEVFUQyCcLe9IDdnPu0dETSYSCjNpBrAnuqGozUVFwqfbNlc6E0OOuiq1FBJ05VbPsi1BBDQNsy9is64+FeX/8f/rF43dbA0lIPKQTaePESgYbvrBrPW1r2eaDQwRKTk3AjLRY0q5cS6oPyIMi4Zl8xiRNmuDmNxNX4oFdHfweAMdVKUFypLG3XS7d0m3kgRsnpKmKBcgWXsaNus8o6SUc6lfRuJfH/67zSPsdxdCJYZTY/QrwlzKgqzfcKiqkKfR5hXifvW60ni7Y5i6NgY8eoww1hgJGJMRIz9Yfzn6Y7FSMRomRi61kgXcB41gwNHa3cMhOimdIeJRhbY3rFYVPOSugdnFCEW9QiV07bvghOB7SJZbhKtkjyyw8DWls3XYtKWCOf8y5RgpOIKnCnBjhaasoE1ZnZlwRPTwe+C8KEhHlLDa4efO8ybjse6+PpzTjMad08ErALDSlIWZLON/H+P8uGKO+tPzsBziYvMcVx+6VwfNZWGUJxTCow46ftIUBfLeQjXJv0SnOx6ntgla5rwowmDu8Yi1FQ+/EnRkcgWZYhc6NYkO7ymuLA24BOOb2ocXVNYUleY48dGUEm0u/IQLed6HMhpjVWJaBucibhThjEWMXZ0YpRre9tgazv2hO2k0u1RF/6NbFEdxgUlXGlSm4RAV8zzUVFJKCuiBZ8IkY0BkIAZXuJFIyvD0fiZydnuqVFWiDAWMb69J8h5jLR7kYShyMY1TfnRCzkOnaM7YAXvzzLY9wn9Ho33e/4pX1+97qmDmWh1sCgWh9b+sal5nmlHxi3UoMQTwImPIy4vwLmyn5lqOgETEWPLtMFr+rwsTqVMrynetTsJdBjauBDlE6FlOYulU/QqrTdYxA+sbRibpk3slThfpdUlbFqmfG0nMLFRLKoqLG8onNarcWxDY8CPC19p3hOl9PuoqIJdJgSdJw1yQUU97ZRcUCEsrno4uz++z2ORxfa2xZZpi/snDba3LfYH8QOoqjyBUI5PY+f7o+Q7vOT+PzZtcVJTZ2Fm2yRweQKCRDbOLToW8JMVHdgYUEm3qlhFP74XtSQ/qWvgeyMROjZttnJqH5QvNEsIOEf3ofz4PCqRrk0iDTKRNe1mpd/GXuR3Dwb2PbAHuWpI48phc/61K0+PNN0ZRlDGsrIlosgzhSMyrnUF36zoB3BnlUuS2iVzffR7CkHyMCBm/9nkW1M33ubE6sWu4yHvWWqKsGE0woOT3R5uReULVe5uKelxtk84uUfj9D4PJ/VoDCRhUlqktA6JkQ6hv/xQJIFc7pWfeI6OZTwdMO6fMLhnLMKmaYMpw6gpyvWql9WmctBvcsxL5/qY5ccbDyfM6rTQGHIR4jeOQEa661cSOopPhC3TBuv2R6gku46xAhGUZQLxedmL4vaMpDfPE12SLn1eMZg1oUdjQpvKyesue2YvckAUayh7E33QVrQXGmttySAZnkEus2zIpuy+y8lfconIcvL/t49GMbdHU47IFjLDMKNtu7R6nbl22c/O2XErivDApMEjUwY1lW/1laiJXChtE++QR9UV3r2kirXH1vGbR9ZwziwPDQ1MG8ZUlM+LlEO5OVgNrIOlP0ggId2EWjbOVUKOPcyb5vn4w+U1fOiYOq6YX8EsnzBtOFmsccKsqTjeWVa0A8u4cyzKIVzpiaYkTy8xvHRKL6Er+SPbdqeTh7I/ZNwzbuKE3dmqu3Wg4vqyjsI/OyBQyvuyPMNcFQKRYRPVdZ+nO78tKPGH7kHWrIFauxb2rTeed/xetve3Q/ajhC6JEkEy7Uw4cqvOCsWdSyGPy+vCoEckO2Lcj37egNf9nah4y4p8OpQzsHFNAdwlLFYU4QfjEe4bN7Eyxgw9GWnfSSuJSU7r1XjDXB8n92jUdJzcp30JBxpV9nyqlzwbtZN0oVRV7An2Bha3j0a4dX+EHW0LQnyPSGggu2PufCJMW8byusLgbD+pO3CC5FFWbwptWnmnLBz2KS/b4xNhJLRYNxKhk1hNmh8V5kFyPtcjRx/JcnkLAuMZZrEwmDxCk7DvhD4+4TPnbBhJPsCH5EE2JpY1Zc1vUl1XAmu7ZFYuSlHmrLpkXrl1pD3Tvy3nRd1cUlqUKGM82bK4aV+Eto3lPdNcoJPQFiqJoka3gh8LBkRJgbFtgdtGYuOoqPx5y07ANGyYiuJ+lD8+poYPLq/hjD4PDGAq4q67p0Nb8C+mbr8Ua+tYYDyKUbU3z69gzbF1/PLiKhZW40Q57umgAhMAWZEV2NKyuHV/CMtxqKaS36Wfrao0ceZMvE82Q3lE2DxtcOO+MPYk1G1+ciFaV8ROamdxmVKmaDGwjg4xi5/rOLchE1nrNb25u6fVuwDwgeoiNKNCCYEHbxmcy+3gkSlglo0YnHQKkhwfXDYO2SXDlYRetoTyoJzCleF89TTgGBo9sz9u5En7oSNOK73Jg05CAy2g3HvHY+PyHehTOSHghAGWVBXevMDH+bO8LOlnLm94eqG9AL0AXsWjGKEaCS2u3Rvi+r0ROpaze1MmBZR68lke4TV9MdEy7a+RTGgpu+ol1fOdHYuHJg12dGyGJLriHEZsisoR2pYhIDuETtcYcsIOXKyHqNhr2WpNU9PYx7fsrJz85K+s68zkRbyZFErWYV3EQfiL3PRmh2OBUYlCSdnsbOsMggQVKRC5pihypqmKiU0yFlVCKoiSnoKIGbfsj/BD3+DYhsKCior70BWyRNkwsDe02BMwtrctRkOGp7ohmJtQeuhyuS6Z6+NtCyqYWyFMGUaY1FCIXpgFf6hG8FyMRvLDxqPYE/zcoipWDnj46s4APxiPoCjmhVl0i3pp4danWMHx1v0hZvuEE5saixOMPG0t6Nh4c5oywJ7A4MmWxe7AJi0JKMLalLLtOB/yUr6/xi0cQrIXUgkkQTIlR1tLkjYBqKBjTLXHW37M4uCKJ4HhIQzpYRQ5WmUGQutWrzO/ds8Z/hP7+FdHOxYq4VyVzQVP1byNnDMu7oAqmWkhiXvKoV9oAKTy06EkfUJRLBA3ETHuHTfwycBLEsQ0J5k2MbTbTpQ/aioOtcpibI24anxETeGXjqjg1b0eOhwnu/p5MowDuWt6Ht9/KK+UEzYRMZZUFf7v0TV8byTC8M4AOzsWvR7lnku6saX3b0/I2DMST9htaIq7PhMlxbbtPgNKWNSMGMEiZ057mhgcEO0TxWUPXe0CzlRN8uvD7SNJwx7D+a5VALAGv07A8IqPrOCDegZDPKSHadhc/p1VF7VI3TQxbawBqZTurBwNW1WS6MpdWolBL+RQxN1BL10xtDyWzQ6qIQlpKUDAzmSklPwW2a5H00lxCwJhahlg1SwPv7i4gtmewqThQ84tXu6vNEzu0YTdgcWXdgS4bSREU3dzPeVUz2Xh0TjhkpLsYHZmJTrrwA27C9i6szakV5BjMMgxJEXFYa/u0B4FcLNKdoD06f/7+tt+tIah1jr9IsUkPambTHfwzikiRMw2rYYC8RAZLpFmYWeOnUS4MpfH5YMp3d3DOMmWFCCQPctGkCNdXD/iruGpDCLkzKhNUsD7hcUVvH9ZDQ1FmEzGNdOzUB95NkM6ZWJpS7oK7UG25eJ5EEdTiTfp9wi/vayGdy2pxpQQFs1gtsuriluci+xtOT2qY/P6XlJ8zzp5kRS+cxFPqWcggQTrGJWaIV9RlFfS4S4AYajmabD9BQC49dZBdWAPkiTnl373vHlTU+bhSWC2jZiJSvltBWUSOVNCkv+UU1uQNAE7wwqUXBtXACI3DMbl4VBR9FiKuqWoTo9HeO+SKs7o9zARcSlcy89SgX0mmVCIKrVOqSRUrpUbLyLuGo5zjBcKFUu/u9cjPDRl8G9bO9jeMWiorgielDeSxUBXGhQlRWSZZ8qQPKe0KYf8yIp5SeU/x7gu0SF23yNzZwKsqihVCfkJO8UrNly5oe2uRq8sOQ9a0ZvR9GbbpCGKHE0r0MxashHnEyPtUqyRn0EnvY4ral1QI3QSN6JuAi8F3aRgmnXg6CkTz/T7naNqOLoeSwrNNFznYATccADlwzSJrBDgpU1PNuZRpQTEsZCzECUNVxTinvB+L4ZPZ/lxjF/RaQdlrHBvBPPg+cyTiOIk/tiGxp8cW8OntwXYMBai36Nk5F2e6cyyui2bx8hZ/I5xuEOL2KmDSSEHNYPKpEfdCKJs43BnvRjOIZeKA2vR0Ef1VOyFAAoNVTkDWbd6tQXWwTKuDAzYorjoqKRnW16kVL6DEwfmFAqFzL4WJDZTNszGoaDkaijkqDYij1Klv/NV3IR1XEPh/ctqmFOhLBF/PhPi9D5VdUzIa1vGjg7j0akIT7QMdnRiNu5UUtG2Tt2hYxk1Tdl98VU893BuRWFxLZ6FcnxDY06F0PRiImbHFtG55yOJbxtGjyZ84KgqPr0NuHl/hKbueosyFoXseGR2RumJn1tHJw0ljWnW0TJgZw3K75FdjnBan2XhkSivG2CYradJ2RBXAvj2zGsgGV3w+hvPPbJt7EMti0aUqCRKAQCFfP+wRbFh3pa41tyOwcVZHLK1VSJXeoZJTu5OZB1XKpP7qorhyROaGr9/dA3NpHCo6eBhV36GEc7pNcdKiownWxb3jhs8MBHhiVY8VMcmLNa0yqyoOLnK/Y4oodHIWSMNHcsVvapX4zW9Ho5uxOIP7cTo6HkwFCugVJ/i4uz/7AowvCso8NTKwlHLRQa04fLZh9rxuLaklODy48oGGPFBioTLjcwD2Gii+Rq75vWZE7608q5xZKteeJDB1YNq3dp1rMBvQsNrhGOB0Wnto+TEcsiBMz5ZUVGZIjfrzlF2t86EI1dsoPAQqLw3QL7HiHbQaQOc0uvh/x5VQ48XFw9rqmts0TMM0kTJAibHMHq8mOd0+0iEdftjBZLJxB3WFdDnqQzmtM61KUHJgLPzpexdj7tSq4FlbGtbbJ62uHZPiBU9sQLJGX0eBvx4aJB5FoVNuevXVbfQNx5Z7JpmrOjReE2fh7vGorhtFiXtyUIdJXLmyEud5jLmbjb9SoI54j64XqssEpH96/KhiUp6riBpAOKIbavuLWxP0wUArk5TjZyBrF692q7DOibwFYGxsT5KKvwsinhZZVXFDEypxapQPqOPJSwrQypyQiLKT6CSbrFsyEoZbZxFCJaGAnN8wqVzPWyaNtn3V1Qc4/d4lA3eifjAiTiVLKaGjnslbt0f4sa9ITZNxxpIFRX3lqfXkcrngIvzyY1TB5I4v3aqzUaIGzR0bDAPThjcN2Hw7WqIwVkeBmf7GEiIifYgDEXC61UdF0gfmYrlhnZ2DLa1GSNh3GuS0npsCcMy60pEHgouk5m1KF8L2hmvDaf/xjo0n7Jw30jqkiN7OsP4O2sU0XiANwO4uvjMk/DqipvOXjAR0mNjTL1kma3DEZND39lFkgTUZg+ENLjtkiW92nJXAIqhWwb/Ong4c74CmzZMXTLXR58HdExs8CoJetM+kQGPsLBGmO+rrJvxQDmITVpHa4pw30SEr+0K8PCUAYHQ0PnhmW6CyVwuvUNSbshhFBCVoFwOXO6r2HMElnFETeOyuT4unOPBS8bQzWQkKbmzrgi7Aovb9kf4/niEre3ubEE/+bCv4jqSW9V21wCXJObMJXKuzvMFilpXuYQdxbXn0pnKitmy27UoWxqXMqpVpfosP36z7T8Jb7yukx5OpeEVAEwZdT7XvV5YNoa7qFhBOobyTf5w2JjSjSjRZiuTUXsA9UI4F2O5ZGa4wNxl37hy6Arnz/Iw24/7uas6FhsgxDSLVGljd2CxcTLuLtwVcDaxquwcbeI12obxqW1t/NXmNh6dsujVsWJ8SV9UMUaeoU/EcB71UY5CR65VwNlowmTaVkPHrN3PPdXBX25u47Epgx6Pig1JyZ9eL9bq+sJTHXzksRb+a2eAzS0LTYibv7y4x8SjVIoo3wefoZUqP1bBZdamOVfETtGX8vli5lU4L45huEiLL7QplOgdsCNUSAXgiKEJysSiw0e9uTb56qSTVhVQrLqmi8c1YJg5ncGhRMM9U966XeQkk7ShoodRAt1iR2JSFnPYuRC567jsYSu6/awDCHQssLLfw/FNhdEofsBty6gmwgJI2mTT1l7DwLhh3D9usLNCOLap0Ku7/Q1Ztdkj3Dce4bNPdfBUm9Gj85QHkvPIKa+tK2FJw85Yas4LPUiKh6TcdEckxwiWJ4h+KduhooAGER6bNvjLLS1cMb+CK+b5qKrYiwIxcMEg3Lg3xH8/HWB/GMvxpIN42BHFI6eXPW1H5mQ2oeViyCafs3FqZSiBd10pV8tFAECGo8rZbKz0Vg6NqazOlNf5ZdOpaC9qRRcDuHP3vN2UqZo8+fkn+dfuOcPfN6X/qm1pnjHd1NyWjSyg8h3dLc7ZEixaJlRlTS/sytM4F6+dmoybrFdUrGCyrK5wen88diBVHVHCsFO1kfiBxYJoXlK4m7SMvZ14wQx4lCXxDUW4eneAT23vYNokOUAqfOYUvMjZHEDFWo879liXyN3AGV+gS8Y1SwNMNyKThIEMYOOkwcNTFsc3Neb6Cr4i7A4Y/7K1jW/uDmKpUOWMxHM6QVkk1xVF6PUIs3wVgwKWc+FOLqREUU1FOWtFklZJCE5oB/gpzDKhAzTnUV6jjB0gSZPb5kvMmlTTWt7yn9u/8ORRTwLrwIRYz9me+e0zj6963v0tgwoxc8T55ynlLmWy4E4hjaTwAYriADPmD07lVYZs8mLcaaxwiIcWsZTOpXP9LJnVhJxmVsoRcsdAU6I+7gkt3ZN7NJY3FCILfPapDr6btInK+5Jei5doAxOVz/ZgR5K1tFBaMmgTJfewlNHA+YRXeq22BXo14VeXVFFRwL9u7WA8iusc6Qg762xcOmkaq6oYVj6ipjDgxSIUDR1fqyZgR4fxnf1h1mYLx8OTlGLNBnDmC41uTmJLchZVMrqO3FzXmRbmsszTa1SCyZ1ESOz5RL7lfU3fnHDzxXfvA4O8wVsH1Tqss32eXjVZ0RUzGRo41PbM6qTmqyzUCZfqUZ5r5MbayglBjDC8Aq1AkM9MSQiSg3nFea4c8DLx6lQ/tqrkAqXEaDhbsB2bokJxsQ4JvX5LK17G33g6xB2jIWb7KjerBLkFz7milBRWSw3JE110qqQXxk3Q5YWmMbzUq80ZDwm2qwyHkuufNIx/3dqBTc68z6NMCsntygst0PQJJzYVjqgqLKoqeAroJPWcduI1OhY4uq7w6l6N74+bjHKunDzLRZLSMQ1G3itHitZNskvbvbkoMVVgfMhzoTw3K+reWzIR21pdz6mATgPwnaHhIZXlIIHFOZ4GguS5Z7mHwKULyuWU39Vl8bBMNUPi4exUkMkZap8apGyv5Bmqt2lO0rbAq3s1ltQUJtKh9Wkjf3aOiYZVmnclQgLVhCcdJcqNlNzVuorne2xpGfR7XRHn3Pw/dNUk4Xg85vz4aDnn0NV3sij2h8uaiGxftS5CWMKDgzPmwE8abHRyjoFIHCQsXlWEM/o0jqorVFRXF7gdcSbGl+qAVVXclXhiU2NnwhKoJDphM6FuOf6VA9OneaxkYbhj9HSJCqOsL8GdmeJ8fyR6jfIADFv2lTJtcx6A7+yet5vUutXrDDNIkTozChkWpFz3Xhhc4nDqXYYqC8EEiWyVwZMSfnOHxxsuomdlE5PShTTLJ5zSG48MSzvaKkl+wEKqNBV38BNxB53CvknrjkmIggTgpn0htrUt+jTlPSMdOPwxJeLLcqaeYYdxkJIYy6r5ZTsg8jG7ccT5Cli/MEJbQhJNw+NFVYXL5vo4vqlBBHQSaaXuc4iFMrpTf7u1lpUDXjzrQxiHRRHKzSXITlhlREgmNdWso5ZPThhunWIlHWCKMHER7UpgbLKW0TE4O60NEgBces158yYo2jzN1GtNzN4tq3Szk4hiBlYvHF0i6zI3S6Bdl4pSNr+wUHzMXHHsBS6c42NhRaGdtI9WVMy3qunMS2aGFYs2kMidOFNI7NjYszw8ZXDbSMw/Mpwfa6ZyiFJSNHU4YDKJzqE3TthURml36x8uzi8pOnL+uRRnY0dB0Tq9F1JGRxNwWp/GWf0+9gc2bm/W3TDIotvOLBGzFBiZTHhbjyb3rKaKIaCdoQeIUD7HZCb2si2hNbG4dnc4kCoRk/MccfHkGFZXlKpGdtusKDzxW2++d1oBgNHmVVzRvZrZKjFGTU4atSUzMuS8c3YSJVUy7zs3dFGIN5TxqaTuLDuiYBL+oySXWFqLZ2wECZ0jFYRW1I2pdVr0orQfJN4N04fdNrHoWW/SOHTXWNwxx44ngKO8khqHbCSTspm6jNRXstORO1raSULLziOrF8lch/OzP8iRTZW9G5yIWgzO9nFqr4f9oYVWqfhddzhqOkoi5XoZcey0n33SxM9hUZUK6KIs1hkunqskFTLn51eqkj55y+UytzKykDwuRnHEdG7ufXwsZQILpWjprL7msgx5rfg4lioqGxko3Zhkm6Y7kRZJtIzDy6bXlhVxWBgXufG0O/KMi0l+pueULHyPCK/u8xCKgS5I+qNlfF9xB8GgiNFXFaHNjLvGosLYOKm9Cy4qScriqVvYc4WVcxOhnEUNh53sbkjMRa0ot7rtYv8yREFSuEvzwQvneFia5G2G07CJc8VSnTQFMWLVypqYMpyGqZSIVp/a63UjhURRU1Gx0KdEjlkQFpR9MW4THuen28IxAEa5DJAu2WglEzwxNBNVFZ6YbB+fGUgropNZoDeAg907YYX0GIT8XD25g2qJLHBRYpRzfcld7dz0PcYWjc0kMzDSwlxogRN7NHp0Kgjd3dnSKUYexRX0gLnQ0JM+qJC7odCdoxH2Bl35Gpcz5i7eXFjgzAhXJdq3VuL5ZYbgIIGqpObEM1Sjs+ldTgyuHX5PkNBsLprjY7avMB7FdZ9M/FuEUTYJQdNzmDCMaWc0HiP2Ih3LmFchLK6puAZF+RoZJN2D8kJ9LvCRtfk6IaVLTHVVW2SI5okoxDrr2nCeMcEAQsPMWmGg6p+aGUid+KQwZCgiIpRINlIe0kwtOoMaBTlQ0iLc2YOW8xVjOIm6Lck7tNNrLm9gOiLhpKbKEBlZac360kWiqcX8v6rufmc18R6Ptww2T1s0dP5YZU1FpR2WnA+JbNkD5HL5UKkfJsEN48z0cAf4lA1HhQy9hDaVDOPOneVhfkUhtDGKx9xtoy0bkdcxqZftPtPUk8eDcighMxJO7dXxrHQUi8kkRqq5RiNDMHdGR+R6WrdwWCIwF3ExdCUnLDO5GSoEDwxD9gQAUIO3DNYCi2XW2G4UkKA84Pz8O+tUWlnMfyigBo66hKwwF/gyTn8IHDhUymOSuGkM4FW9OrsJleTgqbp5lOhkuVpczOnIgu40JItYuvPOUZNbfFbq8nIxrlfIu3m4o5adTSDbTATXSr5HkdOqOkNLLlFRmT0XkpTQ/1MJ1g4DZ/bHYVU2ag2chaSxgLejRp8I+LEzszwd+JNNuk0KrAsqCsuTOetlG4GcJCUfbG59cYmncNAwOMeXBkQlFfaZ+lZEZKOCkDER4lgAUFOjU/MmIiw0sSwhMbpDUIjKoUq5gIzbxyHgOy5JvsHdHUEiViR4+3KBRJxfBN3RXcARVYWj6jorBkZivl83PuZsISrqjiizSS9Y+llfER6cNJg0nBW75LyOE3s0jqyrHBImURM4G4BlR/wMedKmdcbQFZTfHaa0K4rB7sIoWUQuEztlEyyvK5zSk7Qbq66qoifygSjNWpPhQxAFVUXdEd0QYnGeyMGmLeP4pso8jO8kzHBas6mEN+WCERATvcjJ+RTl6yo5qokQAtFOjiNznyQEpnZo4Ssc+YE7Vs5WJ82pLfd9NK1h5ngQaSnNVs7/zj18hw7iIlVSDFkiK4UOLxmOOT0GcpqRElpbJ/XozBBiqSDOafFChIvpLuip2BgMJwM/k0lHI6HFo1PxmGUJPUcMnNTUeN0sD2f1e1m13ToPUPKQFIpDStkpyMEJWV1INLL5JNZFCSGSbM/xxKok2U0nYHkKeHWvh6m0Fz/REcu0dSkvPp01lXFciK3pRDopMQhPKC+mm0f6xXN9haPrKntGMiSiAzTdlG3EVigjus15bu4hxR6y507OhibWn1y7FgAZwCMa2BF5c9V4x86FpzQATtEhV0tX7mhuIoUSCoALKcrWyhwVA/nmJhfvtzPM6ggZWJr0Z7cSPpBJDEMaY4W6cXVqqIFFxiFKh9ooAA9OmEQqiHOFqmV1hXNmedgbMBoaOKUnFtD2M1SnGF5yySBTcnZ7OfSFktl/kjrhFsIkbJlDiGS3ZknTGgSCE1nghKbGLJ8ypq126EFAwmDOcso4d0sHijJzJpIQiJbc3GzIbL3Ewg+czi3kPIo0E9JpndwJJU1f5BgPCjMBHW0C53uUU1mPumuNYJkDRfVd09Fytc/gRI5Jemw5n+nLOdVlLjtLoJwmltx4A3FT0iRL7ngK+bI/lSA5cCwdiIWlU0+W7g5+usgEspLOR68kCzrrcU90oBjAlpbBk22b0E26/KU+j3DeLA8dy+jzEtGHpkKvF4+FI2fnkcTHMg0wUHncq9MKvnWGdDrdc+5cxFwbKnd32BzlJOGeBRxT9U9s6mzAUGDiYmkKzwJx5Vwm9TK0C9JNyEls2WmxTb1Q2wLzK/FGlqJgbt+QbHCSC984qJxy1h2cPJCcDlRbIkEkEUNC8T5nKCvBtgmok16sIrYDORitZFd0C3OygT5iZza4e8JUbIayDpeLHU/k9oHIPuXAAgurCgurCh3LWZVbGqFP+cp5RXUH6KS7rZecQ10RtkzbBL3h7rhhAl7Tp3MjjFNi39Kait/vIEVAHoVRKPbrszOxKl1Yhh0Vc+TnNsqdkuTm4vTehDYPsUs2xIqmhieg5ng+R8wgSMfBaeHtI8F8TQ0jFZ2wyehti5l7WNKN6riGys5XO1NqIYiqoHyOIRN644APKBGtdkMohSJbVhI4LRdHSqvk5lY0oe7Z41WvoqWcQqQz9+zmXHhhrp24aIM856dshrosbBnH7blKizI0S7/3xKYSeQeyQSyGOWccKfGtbWKEpkt0o6yne3dgsaMT1zxY8KSW1zWOrMf9JOlk13oixbm8rtEU7ix9eJ7Kh59uE5Hc4VxpGxdpKwjKlQypLJPJ0Q7al97THk04qqGyD1cVxRQd2w1n0xzET9qOowTIqOjuCLtOEuul0G9dEVqmC/tnWmSUquUz5lcV+n3KxlNIY1HI10pyiv+c7zF315Gsh0ScJ8lm6CCXt05rZ2x0nheXilWQViAcGSO83SiASnoO2Inh0jZL5eQNEPR1adHKmfudq1lwPizIeSTK0xbmJkWoqSSxTMO29KEGNt3pkDQCUdbk0423kylLRHhs2uZZrcl7X9WrYRODS1UZ03OY4xNmVfJPS5Wgd5KcKJEVCRfDrYs4G4REiMgha1rnuyRgIDee0DIWVBWammKDt4wo8YZKKIbAmQhVUcmcRRt7Go/y9S+Vtfp2AQ0rofXk/VVFOKquc2xkduo4Zco15DB19Qy8NeW0+UIwJNjRdLPONDOpFplO0FIMCi0jZHus8qQlO7u/KlERMZyfCmVKxAikBWtxgdaZ4uQOhc8N28kkYFg86Dhp9ogy2JDEg0l7PoxoyDeWk0XGOaP3CdgXMp5oxWOg02tNAYABL94ZPUon6XZvpkGM0Lie1XB5n4fLE1IC7nah4eIAm5JElovtzpKdYJzwzAJYUqNs16wlmwZnjVLdqrifnIyc9pWGgSGnzWachWmRpJCLwmya9HoAWoaxpJbwuyivb8ZOoUMnTWtwvK0njLismQwz8NngFKqVCPOtM8bOCmVQMKNtMF8pRXOiWEeJ4KiJuC2M7jzvQuFKJOWYwTBcjV35Xu20lrKzQ9Y0sKymEVrOU6QFJygdAhOKuki6uwWy8EmEpzoWbRMPlYzEOSypxdI3dd0NNWR/R2AZC6tUiGvT2oB1Kv5ucTHdAIzL36Ku6zdOHcUVz1DuICAqep+U1l2h2KCnTPcTUgW/Y8UYC3RZum3ThXileEL679Rbs8uWELlYGlbN8hTmVygTwpMTsGT1O6PKU95DRpz3BG4Yxs7Q2CwCUU4nqiMs4rISrODHaSKtOhZz2XAu1NFUbG+UcJtybgih2AFHJbmLFomT2+sOp1NRCp+lO/JcX2V5RfqeGPHgDAAIRKjWSYbpdBKoVwvlEAXgiZaBpqQegnSCrcq8Q2pw6aL1pHCzI96c021yWL/s1Du0Q7KT91klN1BReTuBCwO7gz2tg4VGCXqlhS7ttOkm6lESloZcXEgVJSRhRb6pk4JhNYHJ000wsHnIOGt+Sv59VF1lgz9pBikkdkAKhaJEKTslgrIaW2nZQbKsHalS5NueyRhGRWGhZy1XbdpyyE5DvNPM4sKucCE6h2sjd0u3mi6lQ408QUcAwor4++SeODm2iMerUeK+0wQyTOZzI2GcprWFdtLulz40nwj7Qou9AeeIiBHHiMucShxepSOL04cKFQMBNUWIEu3diDi3c5aBHDPRHUBFTV+TNiChODa7bCNy+xxcNZi2AWb5CrUEYPCSTkKbdE16mdo8JyAGJfciFivw4vHJ0AlNJUzysYoAGLzkOfV5MSG0msR3jLh2xInPWlhNlWK6IYpFsYeFS7hT7uYgAQ+4lXlhaCm3TDt8QuPoSDvHIViANAa8KcNaESF0hBYs5+kdtkStBM7DIKdJR1ZG090sRaSMnGXoQMe55pnkplST8V8TxmRuNExWCoHhJdwqOdHKF94mbbP0kqLc5mnT9WzUnd89FjHuHjNZCBA6jVARx/pTgeVcLcCVwZSiFMZBolx6PJx+cFcPzJ1jXmjMErupnDhsEi8QWMaWaRNzpkiMKxMe3YgJToFAmWwWqnIG8bpSsjJETDlrVlTaZeGvooB2JBgTojxgOF+Dc4uGLl/LlYkqiA5SXn4pZ5Qon7sicx6yXPHk2ASpXqeoq2NaRidWVGTeRo4AgVSzYFeMzZHFYcp3uRmngh4wcOdY1I2dRULFjlKIrOq62koyYdYZY5WzeRw/mjAFUhs5veFpvSCV1YmKO1DO4GWIQiW6xTbZpQuwuNPTYDivJSVZt/KBm3TBJde4rW2xtW0LxUspw2Sdjc6WqNakz9KnfNOTEpX0rM6kurmAXOgVFXugiItNdS55NccKJ6G1VabEKf6ObF71HyWKnTKHIypR7WSANJEXIzec3XSpl0olJy8fnCvOkJNaofzulNOcdQiJNINSuFssk2gbOaxi6T591R3iCCoPE3MylQIxqqiiwWWLSXUfEpdIirqFKlMy0J6dmFtBzDgReaDM0WxJ74kMbxWK8xzThWRE4VTy2nI1GkcpH7n7Frchs9u/LUAGm4Rd7ng+j4rXnyGfzvNhwaiYsZXA4WlRyXgNaSiayqeZqRJGg9vWbTiOWlTExSKV4ZIKupMxui2PzA7XSI5fE64fKM4YtyiOH9ZUZK2SQ99mKULgNPin4LDbsYiSSarMeT6YQh4ullwe6/ysoDtM5XQZNYPaCzuVeNfdG9FhqGcgP+bkk6io6GgFOCGryLas4cgx8EiMrZMj4yLhvVJlyxShssizlpEhZpTbsOCgSQWpUOSlniTimWMnOMeQXYtys1FJTc06Bdoy1RUiIASg/EQh3KK4o5NT/7BcPrRTwsAKxRhZumegfL4hu73Jjv6qcmgXEGGZbCbKSZMmxLq06SjHfSqhkXMJjZwciLVAv0n5R6rIwVJOByVxcWilmYH+LguvLsghv1u5U61KKBS57jxXENyBy8FFaF45Ki250MsJWUns9u6it+AMvkcJDUTmFuTMIiwUR8sIoLLw6uiLpcr4cNc2FXtr0jJDYBnKmDxtOJcMCVEFKVhdmAPnJKvMxfwEVPydHPiZ7eDUFRVj0fde8FLc5fXIIhrLG+rIfUoBMqby3ETmFK5Hkru3dqSIQpuXRyVnEFB6/yzPrJpYKrrshILsyHTKSrF2dGqtM0fcDUszT2HzzG23f8WgXEoosonRM4pUJWfirU3uUYR8dMDOJulOjiIquT9OaKSdBnxX6nWm+l2Zan4+pCd4oK6xlYr/ihFXZZAuSiT8zQzq7WX4tHxf5Lj3sk49+RnZs54TSOCZJ8POdF6Gy0cS2xk61swMx08H8qCk0cdg5om5peEsZrgmLhqR5aIUKzh/npYPPDE391zc3v0DzBaR12lmuKeY4ZzcY7uVdbBzPpyff26pqARTIIY6z5Cdeg/PoPNLDFYVIvZVvg9YZvPSVWeK3pyvmLuowsHMLX4+Rhu/0OOR8WM6R36Wx3mmkdHPxzFeSveTndrIAQewUvHvXAsC8nQrisfpWVX30LZppDBDeFSmr+T2X/uEw6/Drxf1Rc7cdFNSzLZc7CuRqJZ2hoimthDF+sMdFVns1ZoKX0guDIaim0ph18h20Q37MtnZD79eOS8WVH04uSqJQrQtC6FdtkJagogndj2tCNhnY3YnuwUpPUOfQtnQTHYaoQ6/Dr9ejHiLnTAJJQJ6GfwuhCtQIuhHXZ4WswJCYL/yFJGfjiV2pGzYKRy5/SBusOfTc5sxfvh1+HXIU3mRH4bKnO9adWVbXTYFi9ZxWS7wiFAjUqqpsZMTfVsuEVpgR9tJ9kKbEjSFX6IJNIGgSQm1p8OvV8IrY4g7VB6pmokSjhs5RWyTm1/D7GlCn0fb1M623WQS5bAyhICcdlFZ6c5CMO72DaCkYeXHYQyKFDRpaIol0CKOMB5OILDBYSN5BXoRVyguTQeksiI7ur4kOl0lbV9xrPvVtvZJTxFacUGG8irZlJ/YmiPgUVHtjrh8DPShLmwiKl3AnJKmXX3dkmNEHCEwISIbJurlNcyqDOC8+auwffopbJ54HFVVBR+GE17eKJajiwDR1anJGULkKF6mPLlIki+Rp+bM8mjKm1ul+0fBaAOkJR/HonS2NqM4e9AdB3BILpJi+zVs0LEBDBuENiwsel/5ICJUlA8FBUUKlm1ukTMYLdPGQKUfJzaW4Pi+Y3H67NNwXN9xWNpcjNmVWXjvnb+Dh0YfRV3XYdgcXmUvc+8hWb6uDjRKWB6Uk4USNKR8Lw1FEWN/iAe9Xo/GJgJmkqwBzjctkdBdMkn10tWEVaJTi2aSxMwZhoZhg/FwAoYtev0eLG4sQr/fh2N6l+eMI7QhNk8+DsMGO6Z3om06mI6m0fAaqCgfABDaEPNq8/CvZ/8jTug7Fh55he+cjKbw0NjDqHpVWLaHV9gryZWUFRIdLawCs9pVquwyRlQP2A5U9W5v10SwaYq8FilqwDBrAllneCI4L0nvzs5WZVNwnyGMGg3G0PQaWL3gfFywcBBnzz0Dx/Yec8D7ELHB063d2NPeg0cnNuE/Nn8JT0w+iaquQiuN8XAc//7o53DGnNfgzLlnYHnPUaBky9BKY9vUduzt7IdP3uHw6hVSKJRkzMg6U5JRTq5VJdNw0fUyTJpIGZ6uVflxb28Y7u+p+vsiTQ2y3QlCsrlENvmkXsIrYbgCM8y7yCxYIbAhOlEbb1n6Rvzqsb+EUwZWZL/fNLEFm8Y34+HxRzEZTWNhbR6W9RyJE/uOw9LmUniksbixCIsbi/Dq2afiPzZ/CZz8l+Ye39x+La7a+nUc2ViKb1/0NcyuzELIEQiERyc2YTqaxqzKwOHw6hXiOKhEb4zdNgkqTvHlEs9DBGgGWBMmDe9ZTDzi3fdT942+4cZVTwWKliICM4OYHe1d2ZnlaMrKIqLsyuKSXGM6amF2dTb+9PS/xKWLL85+d92OG/HZTV/EQ2OPYDKaipc8xxNVNWn0eD1YOfdM/MNr/wo1XQOBcMPOm/Hw2CMYEIudQBio9qMVVbGovgCzKgPZzAcAeGj00WwE8uHXy/+VK15zUTdMjhdXjuyonCgg2xOgYH2fNFve+tnz7pjwAKAVYQs1aGXbslVECiUdWGVj0sqGS5YxZhUptE0H82pz8dlzPoHjeo9BYEMAjP/3wD/gc5u/BF95qOt6d1HnmqMMrt1xI94z/k68ZvZpAIBvbb8uW/h52gGjYztY1FiY9LlYqPiS8OTUk/BIH15Zr5CXdhqprNOzwpxvJsv164j2A9l2TMysPUJ/RI9kRhMxfoQSjn5BJJiKI5kh9JVUycjfeAaHga98fHrlx3Bc7zHo2AAV5eOfNv4LPvnYZzG7MgtNr5kZg2GDKPnbsIEmjYZXz465p70H9+z7Phq6UZpsGzZY3nNU8v8WCoS2aWPTxBZUVeVw/vFK8SAonxMp++1zkwRE/wiJFnBZZOQk4pi2eCAzkB6NzZWUjnKAGdPkjCfWuQQ6P+NCeo/RcBzvPu6XcWL/CejYDqqqgvV77sKnNv0HFtYWwLB5BlSJEdkII51RMBjffup67GrtRkX5pYudgC4Slvx6T2cf9nb2wSMPzIcN5JWD8+Z5g3CmAUjBDYtie60qIK+kKLDo94SBjIf2QUwbo5XSzMW+Z+MITed6sjk/6D5HTQEhsAGObCzBO45+eyJxGZvVN7b9LyzbbHTXMxUQgwTqJRBu2PEd+NovzScsW9R0DUf3HJn7+dbJbZiMJuEpfdiDvIJQLOK8aIgU5sh1Spa0S5OjKwaAWUFFbdM+scd/LDOQI6cnNnuEbewRbPrekgYoKmm09xUVkYPMghUmoylctGAQA5V+WFj45KFjAzwwuhFVXYM5yHqEYYP5tXnY19mHH+y/7wDhVYRevw+LG0fkfr5l8gmEJjpMM3mFORDZ3Fcm9iHXrkJ+fkhZGaVS1fAUHvrba9ftAIPU0FVDevjKjYFh3O9VFJRQiy4bvOjOrDBCS1WiBpQ06SsorJx3VgLFchKORZiMpqAPkrVl2aLpNfHfW6/G797zRzCwUCUJuoJCx4ZY1lyCOZXZ8Uzv5H0PjD6U0WkOv15BFuKgVq4kEJXJLjk/7/IM2Wqf0NR0H9bCDt46qL3d83YTAPQo3qB9uqLFYKXyeJgS8jO5OdVclM90w0OlFGZVZyU7N2VV9ENJli0YdV3DnXvvBgA0vXLvQUSIbIRlzaUgUjBsEJs8Y9vUNvjKy2omM3G+UoN8PsIwRQR6hk3guXyXPL48zjNdH4OfM5MgJoSWNbo+f9+hnoF9bZ32PJ6hdz43xYqKlXZRcCQPQGjxvQx8mr9nPgPARITbuW1R0aQiWxQfjgdfckH/NePBCOnNVCbesEGPbmJOdVa2gA0b1FQV585fhc9s+gIW1OYlkO8zbRaMhtfIFsNMhSPDBsf0LM8gX1KE0WAUW6e3o6qqUFAIOEQ7aiPksOT2ExpeHVVVfdbFRE0644V1TKdgACQWQEM34Cv/Gb+LiKASY4inQRm0TIDAdGDBaHpNVJSfFUxbYQsRR6Wbbk1XsxD1UI0zZUqHNsJkNI0oPW9ORW2796DpNaFJHXQYLe+fZYvpqIXAdkrDfIJC06uBVBUEE6vUHGDUNHOJOB11VSpV8kCoZcJZVdwBAKtvXWe94aFhCwAr5vf88LG9k3umFM1T6YxkEIi6MyRcFTs5YldqEKmkwT1bjKYjNK8UGIxfO+5XcMOO72B3Zw/6/b4CQXGm3faZPK4mjeW9R+WSsh3TuzAWjiFig4lgP+ZV5+C0WSfjjDmn4+ieZbljPDL2KL694wY8NfUU+ip9h7QLpvWWsXAcmhSO6z0Wpw6swMkDK9Dj92RTeC0sxoNx3LP/B7h77/eze0BEMyJsraiN0IawbOApD31+H5b1xiyD18w+DdftuAm3794AhsVAZQAr556FM+a8Gkc517d5Ygtuffp7uH90I3q9HnjKO+hr1KQR2ABT4RTmVOfg7Lln4MT+43FM73JUlI/QRjBsMBVO4bu778Bd++7FeDiJPr/noIxEUeztx4IxVHQFJ/efiFNmnYxTBk5CXdczzh2zxff334fv7bkD26eeQl+lFwqUzaR0VRYJMX/Q1cuivKql1RWttLGP7kNlEwBauxYJ6yoW8rbnXrvq2rCmLm1PRkYTaevI+JMjx0nO0BiSulLJDR0NxvCZVf+C1QtfB8MWXrI7KFL4/v4f4gP3/CGenNqG2ZVZAPiQd5syL/KN1V/BUT3LENoQvvLxP1u/iV9d/z6cM/csXL7kMrxpySU4srl0xmPsD0bwsYc/iS9s+S/0+70HdU6aNNqmjdBGuOSIizC07Kewat5ZqKjKAT+3fXoHvrjlv/Clx78KBlBRfumCPbrnKCxrLsHxfcfhlIGTcEzPcixsLMhImW+59WfxxORW/Oqxv4jLF1+K5b1Hz/idgQ1w9bZv4+82fhQT4QRquvaMRqJJYywcw/zaPPzcUUN469LLc/cwrVfJ18Pjj+JvH/gnfHf3Hc9oJJo0WqYNZotLjng93rH87ThzzukHPKeRYBSf2/RF/Pumzyds75LwifPdhFKphwRCy8xRs6+i6+3w32++ZMOvDfGQHqZh4wHA4K2Dah3W2Sbh5sBXl0ZEnMrDs6OKraVeFvJjCojKZDQZN+z8Di5YOJjbKSxbnD771fjv130Jf/3A3+Eb26+BAqHH70kMzx6y6w9siIX1+ZhXm5vb0S0b/MuZf4f/s/zt2ftT48nqODbKKvOzK7Ow5tQ/wkQ4if/ZenWOzlL28khjJBjD0b3L8Men/D4uTK6V2eJ/nrwa1+y4AaPBGIgUfPKweuH5+IXlb0dN17CkcQT+6JTfw6p5Z+EDd/8BQhvCU3GthpIwtaZr+NNT/wCnz351CWpnMR6O4WeX/TSuXPY2eMrLjICg4Cf/ZgCRDaFIoaIqGFr2Uzi+71i8e8NvYTqajutDpTWlOJ/ZH4zgsiMuxodf9cEMIXxwdCO+vvWbuG/0QWybegpzqrOxau6Z+MBJ70Pda+DEvuPx2XM+gd+5+4P436euRb/fX3ofPfIwFo5jaWMx/vzVH8Z5888BAEyEE/jKE1/DbbvX44mprQCAE/qOw2+e8B6cOusUzKoM4HdX/BaWNI7Ah374kfj4QnUrZxxCZ4G5SK61DOWDqd9X1xfC4RjJGjaX37Ty9A7UPfvaFmGs1k3SCGROopwqJnN+hpyMFAxbfH3wSziu71hEHGW7XupJAOC7u2/HZzd9Ebfv2QBmRu8hGooihclwEivnnYUvnPtpIEnGU4+6p70Xt+9ejzv33YORYAxPTD6JJY3FOKK+EJctvhir5p2dJfCGDRQpbJ96Cm+99e0Z2XGmnW9/MIJLFl2Ev3rNRzCnOjtBzTZizQ//At8fuQ+adFL/iW/KdNTCOfPOxmdXfRx1rw7DFhXl47tP34733Pn+Uq9DICzvPQrnzVuJX1z+85hdnZ0ZNIEwFU7i6u3X4u5992JHayf2d0bQ8Oo4uuconDnndLxl6eXo8ZrZPU83iPV77sQv3f4eNPxGaXinSGE0GMP/XfF+vO+EX8u8xSce/Xd88tHPYCKcRFVXUVE+DFuMBCMYOvKt+OiZfxdHDMrDeDCGK24Zwr5gtMCk9pSH/Z0RnDtvJT565t9m9+97u+/An/3or/HI+CZUVXx8IsJEOImF9fm46vwvYGlzCUKOUFUV/OH3P4yvbb0afcIIpbg3nBxFjqsAgz2PqGJ5vMej4268ZP3udPloANg4vBEA8HvvX7D3R5P654yv5tiImRIDsY4EpCqZzqooLz4nb3BkQ6x7+jZcuPB1mFUZQMTxbq2SfISZcVTPMrx16eU4ffZp2NfZj82Tj6NtOqjp6kEbyHQ0jcEF5+PCha+Li5AUx6V/8P0/we/f+2Fct+NGPDD6EB6ffAKT0SS2TD6BH47cj//eejWmTQvnzluZLXoCob/Sh+t23IinW7tR0UXUTZPGWDCGyxdfin856x8ydO2R8Ufxjtvfja3T2zGrMoCqrsJXPiqqgoqqoN/vw8axhwFmvG7BeUlibbC89ygEpoPv7b4DDa9R+L6nWjtw974f4OePvjL2ajYOa76z67t467q34/qdN+HR8U3Y3d6DyWgKe9v78ND4I7hx5y24YcdNOKHveCxtLoFNFm7EEZY1j8RDY49g49gjqOta7jvTEPkPT/5d/PoJ70JoI2hS+I/N/4mP/Oiv0ef3osdrwlceVOKt+vxePDaxGW9acinmVGcjsiEaXgM727uwYe/d8T1KvkOTxng4gVXzzsKnV/0L+v0+MDM2jj2MX7j91zAajGN2dQC+8qEobpLr93uxs/U0ljQX4bVzTodNNrPZldn4xvb/zTyoK3LNgr9lOc/XAthW6p7qI/7ujZes/yTWrFG4YB3nBEwGbxn03vPae0NSdGM80pVtOidBlehioWziVEk7SFrZ3jq9Hb98x3vxwOhGeORlO7UMuRiM8+avwufO+QQ+u+oTGFxwLibDSYQ2LMS3MyXppwycmAlXEwi7W3tw7VM3oqarmFUZwKzKAPr9PlR1Fb1+D2ZXBjCrMgufePTfcffee6ESeNiwAYNxbN+xCGxY8CDpwz1z7hn4/878m6y+M22m8X+//8eYjCbRX+lDxFFGpUn/hDbE3OocDG/9BnZM70wePsGyxa8c8wtYUJuP0PlOhTg0OqH/OCysL8idy49G7sdkOIUF1XkYqPSj6TVQVRXUvTr6/X7Mq83F1qnt+O17fh9Pt57ONg5KEtuhZW8tlMxi4xjFTx95Bd5z/DsR2BC+8nDHnjvxVw/8fXYOEUfZs0vzmLbt4P7RBzPEjcFYNffsGHJPoWgidGwHC2rz8Y9n/DUauo6II0yZafz+vX8MhkWP10Rou8ePpxNHqOoKfjByf24zWzFwEo6oH4HQhjH8TU4tzxn/INe0YXDVI/iEbwGgwdW3KjgKP0jhXiL19ZplEJLYR0DdnpxX4c5e4G58xyVV8F6vBztau/Bz3/sV/OvD/4aJcCK7OMMmw+0tWzAzzpu/Ep9Z9XF87My/R3+lD5PR5AGNhMGo6AqWZagNJwjWDhiOkh2zS4Bkjh9oClN65OHOvfdkx6Lkv5FgBJqUw0mLuxxnVwbw92f8ZdYd6ZGHLz8+jPtGHkCf34fIRjOea5y3jOKufffmNphZ1Vl4zexT0TKtfDGUgI4JsKi2ABVVyTwkADwx9SQqqoJQGGO6YNMW5oFKP3a1duOzm7+Y3WeFuM5wbO8x6PV7YKzJYNyWaeOonmX4yKkfgmULnYRlf/vg/5c9t5kgYssWgQ26OQwIx/QenWwYJvtZx3Tw56/+MBbU56NjA3jk4Qubv4z7xzaix2uWwtRwBpTG18Ko6SqW9yxDO8m9pBC2FiLslp1BpwA8RZ5uR0HA/rUAeN2t62zBQFK4d7TVuiNoma2qohQhicG4K40ic5IcwuUMkC+jitR0FYoU/v6hj+Ett74dn9n0BYw7hqJIgZLd1LLFpYsvxvDrvohTB05JjETNSEXp9XuwtLk4txs+OPYwpqP2M1JMGIyxcLwA2T7d2p0YJud+Nx5N4H0nvBtLGosR2Qi+8jEVTeG/Hh9Gn987o3G4C+np9p5cQRQATuo/EaGNHA8SF0GPTljKMY1fw8Liicmt8LWXFM7KXyFHaHh13LHnTljY+JqSw8+tzYm9FodZjBzYAB865ffQ6/ci4giaNDbsuQsbxx5Cv9+X7d7uH0UKTa+BYxOyaHofeyu9qOpq0uejMBaM461LL8eFCwcR2jiPGA3G8NUn/wezK7OSDbd4fI88WGac0H9cds/SDa3X7wOxyajsVBLdaHJmtBNMpa5hLN9548Xf3bRmzRqFtSgaCAg8xEP63jffO9306IZaXUERDJVMH3LVE8mZzUAHWBAEwqzKAHa1nsaf3/83eMutb8enN/0HxoLxzEOkiaQihYgjLG4cgU+t/GcsrC1A2xRlexQphCbEwtoCLKjNzxWUtkw8cdD8qyUJOpO65f2d/djf2Z+gSjbbsdqmjWN6jsbPLPupOKxIvuzuvfdi69S2g2IJpDWbh8YeFqN+UPh/F8M+JoFv00LY7tZebJ/eAZ/8A7KUmRme8rCr9TR2TT+d/QwA6rqOfr8vMQSFqWgap886DRctvCDxHvFz+fzmL2NfZz/2BfuxPxgp/bOnvReBDTA7SbbT12hnDB3TAZGChUVVV/GuY38pC50A4JZd63DfyP2YjKawr7Ov9Pjpd6ftEV3lT4uJcAxEOrsuOVJBkhg1yVHZzI2qQo+iq4nAt4rwKo2auq/h+K9pg69QyO+ygEqff/oFyuGwsNPAYrl8BobcqQ0bVFQFdV3D063d+Kv7/w5f3PIVvOuYX8T/Wf6zWSVVkYJHHkIbYXZ1Nn7v5PfjA3f/AWo6X+UmEDo2wPKeo7LPpg91y+QT8QJ/hgWrSWeLLz3zLZNPYm9nHxqC2qJJoWVauHzxpWh6zTg8TG73dTtuTrwAHSSViLPduChxVKRVVFQl63Pp1lGewkQ4gbquP/M1QmMqamEymsp7FxsmIV08hDowAX7qyMszT64SZsDPHf0zuGDRYEzZ4XJI2MCgx+vB4vqiWKKJYwPYMb0TE+EEBir9GAvHce7cVTih//gk3IyX4cn9J+JjZ/19LMnEXLqCiOLw9qKFqxMoPP1ZhG1TO+BRzPJmMd7ApZ2E6fg/BjMpL5qM2oHWXwcAGV4VDGT4ymELBi0ZHvveLup/SFXUSSq0NuK0Ep+vgbAzkMWFfZ9pcURsUFE+6noW9rX34U/v+0t866nr8DevWYuje4+ObwBRxqF64xFvwMf7PoWtU0+hpvPKJBY2q6BbtvDIQ8u0sKO1Y8YH2u1lidDv92afTxf41qltCEyQ261MslAvWrRaICMKHRPg+/t/eFBFN0mLWdY8smAUriILgWBsrPyypLkk97snJp9ExwaZseKAjGiLpldHM6HspN+5PxjBztbTcR5jI/RX+nHOvFWCDxWfxUWLLjjkwm16LduntyNKuHGhjXD+gnOyXCgNm4/vPx7H9x9/aLSUpCtpNBjF/mAEvtJAYjjusKfc1OU4yrBeQyu/Y269+eLbtmANcuFV0YMAPHjroDd85bpg9XUrv1Kp6bWdwFiAlNQfYjH215a05tIhSI+mhuIrH3Oqs/GD/ffhZ777i/jieZ/Giv4TM0/CzPCVj1cNnILHxjejrmtO0kbZ7po++O3TO7CzvRv+DI1VKeGvbUIc0VyIRbVFufBs49hDJa3DbSzvOQon9B2X9bwAwK7WLuxu75mxiWumEKvX7ylwtHa0diaxO+d2zcW1IzC3OifXZ//I+GMH2TtBiGyAOdWFGQKVnvvu9h5MmxZqqoqpaAqvGjgZRzaXJIk+QxPhjj0b8HcPfhRNv3ngUA5dFoUEPJ5q7UBTN+JcSNexau6ZyEsyTeL37vkQxsJxeKSfYc4JZ3krEYOZMG2mEdhOnJclBsJOcZudOZGGGXUF0h79BwAMrh5U69auO6CBYN3q+A3amK+oFn3IgipgcEoOtTMMWrFCxtFIbk1S5zg4Q4nQX+nDaDCGP/nhn+Mr5/9HEh4hi1SbJfUByxYNr45je4/NLbUnJ7ehFbUOSBdJEakljSUZLyndlTZNPF4Iz+L3Lo49hYifHxp/BOPRJAb8voMiOTIYFeVnUkcxLzcGKh4aeySmnDhh0OLGEZkBprvuo+ObDrgB5BQnbYSF9QVdEARxaPDw6KOYjqbRU2sisAFO6D+uIMx3485bcPueDZhdmfWsSJwVVYGvfQQ2wPzaPBzZk6f6bBx7GNfuuAF1XT9obpgM9zXppGbGuXnyBfWdrtFYr6K134p2LOtV1yRr3xRbKIp30q5Zs0bd/Ka7H22Abqo3PQLiM2ZH5zRHa3cUtokIU9FUnJgdQpNSaCP0+X344cj9uGfv97Oe9nTZt027kNDGOcosHJmEH+lvt0w8HlNIDvj9hMiGOLn/hC6QQISWaeGp6Z3x4mMWsqYmQ5JYPMjJcDI7z4OhxcS1kLlYlvCZ0lj66faeWOtLdUPI9HvTc0zh2OmohR2tnXF1+hk2IZXcp5P6T4SCgk12dgC4e9+9CTQab2YLagvE7o+E9jEZFwb9nmf1J6X1GDYYqAzkwlYAGA8mUNEV9B7CdzS9HvR68d81XS/MBaEyaapMs5dtf1NDE33ps+fdMTF01ZBGSbtQKWa68eSNlKyWTzQI0EQ5KSB2uPdW9IIoAjylMBFO4B1H/xzeecwvYjycyOA+HLSki8Wezt5cOMJgPDqxObdjEhFCDnFEfSEaXj3LW2IPsBlaqWcMeBQpHJ2iQ8m793X2xz3syjuoJHrr1PaD3giIYiTshP7jMLs6K4fk3LnnLowEo4XvJRCWpzT+5Gf7Ovuwt7O39BzLQh9PaZw997W58HIynMCGvXeh4dWyhPz4vmNK75ERxc5D/ZOxu02Ao5J2aOmJ0jD6kI+N9Pg2K3AU5EbhzE5nMBHp9nTUMcBn4zLHCi7fWEpew1cOGzBoZGtwQzAdPaCqOgYohLCvhEMV8kgXM8MjH79+/DtxxdLLcmSxZ6Mpme6OT7eexrap7Rmenr4jtCGWNpfGCFZaH2CLRyc2oUKVA+6uluOk26WFPzq+CePheCmJr8xAdrafPiRipbEGg/PPzcHfAPA/2/432wwkRFvT1QI1f9PEFkyEU4X3l31fx3awpLm4y5BNmAZXb78G26aeyol5SxKnRPmer5ef9K24ummH2g4tdXbJmZ3JyCuCUn4ala02PapaXL/u0vUPx95jrT1oA0kYvvre99wb1jV9wq8QxdbdpQpLCXkr2JGKFKZNC6cOrMC82jwYaw5ZSZ0RJ+SLGguTf8fnvmHPXdiXKpOI7jlmxsn9J3abpACMhmPY3d6bIWAHUoKfVR3AksbiXOK6ZTINz3BQi+WYnqMP+voMG/RV+jLWr02KZxv23o0Ne+5Gj9+Ti8Pj3Ky/0Gf/6MTmmFrxDAtLk8ZUOIUrj/wpNL0mIhtlgMPnNv0n6l49u8cMxt72vsIxThs4+TlPfUmT65FgJEve0yawE/uOx4DfH/P0DmH0Wjre2xUakSomNlXd6Yoekh9ZDgn/8Ix5zky/WLd6nQGDtDH/ialoR62ilaKsbyov0CD60cGEtulg1byzEl5O+5CSOqKYgnBUz5E4ZeCk7KYaNvj8lq+g4hibBcNTOkt20988Nb0DI8Eo9AF0eIli1ZWljSWYXRmIH1oWnj2egAxFisiTk1uzz6e/X1iff1CbgEceJsIJvH7haixtLknYA3F+8A8P/nOh1z7usw+wrLEUs5JwLH3Pluwc+YDhY9t2sKSxGP/n6J/NAA9FCl/c/GVsmtySQNOc5VWbJ7bkvh8Azpt/Dnq93lzd59kYiK98bJ3cnrEmYqq5xYL6Apw261WYDKfglXiwGY1f5XMMJWbIu9PQkiq68epaVYy97bZL1n8Xa9ao4SuHzSEbCAg8eOugvu6Nd437Sn3cb2gCsy3MRxeDD2PY16Kqqjg34fQvrC1Af6X/oG4sgZIFNIn3HPdO1HUdgQmgSeNrT34dPxz5Ua4fPaWn9Hq9WOo0QD05uRVt0z5g7kNJH8iRzaUZapPGwk9Obi3UT+JQp4YfjT6AkWAUsuv71IFT0OcdGMFKPVbdq+O9x78rK5pq0vjEo5/GXfvuzSjpOXiWQyxrLo272tJzhMXWqa3wlH9ALeQ0wf6DUz6A/ko/AhvAVz7u3ncvPvrIJ9Hvd7smGYyqruK+kfuz70kRryXNxXj3cb+MvZ19WXHvwPe2+5+8fxVVwY7WTjw2vinj3aXf/f4T34umV8dEOJkd/0BrJuXvaYdaAkeYgeWAHGY0NMHX9LcMYOgjG+lZeZCsqsigRkN9Sk1F+8hTmrqxTV7zlOLDtUwHx/Qux+mJROjs6mz0er2lN0z2OKeSoLtau/CzR70NP33km9GxAaq6inv3/RB//eA/osfrKS4ea7CovhBHJOFY6gG2TD7xjCFB2i+yXCToBMK0aWFXSf0khmYr2NHahW9u+3ZG2LPMWN57NM6c8xpMRlNZk5Ib5igijHRG8Ecn/x6O64vlVyuqgi9u+S/888OfxOzqrG6PtywoWisoJvE5jgXj2Db9VExrEUbcvZ8eQhtif2cEf3bah3DFkjeiYwJUVQU7pnfiA/f8YbaLp9eYwuX3jTyAB0c35vhxli1+68T34oMn/w4MR9gfjGA6as0o3BfPe+kkff+U79uJpvCt7dfFx0V3Uzpt9qn41Nkfw6L6fOwP9mMynDwgYbFtOpiK2rlxz65wddoPkqQDplr3NFrRPTeMrL92zZo1apiGzbM2EKyFHRoeUte97rY9PuhjtaZHhtnkZr8JpcU4VGhh9YJzs0TPssFUNIXRYBRBMiCHElHq9AG0ohb2B6MIbIgPrvgA/uo1H4Fli6qq4O5938evbnhf0mmnM+hRk4aCwng4jiObi7OGnTQef2D04WwMW7mn0ll94VjBb0rpG9untsMnv7BLWo5p2J989DPY3d4Nj7zsIf7uit+En3jAlLiX/pmKprA/GMUfnPw7eMfyt8OwQVVV8PnNX8af3veX6PHKG5Y4CcuWJ+S/lND4+ORWbJ/ekdVO0vOMkvu9t7MPfX4vPvrav8EvH/OOuLFIV/DA6Eb80h3vwZ723hlqDgQLxl898PeIOMro//FiZvz2ib+Bqwe/gl855h04uf9EeOQV6PxBQj5c2lyKudU5uUVu2aLf78V/Pv7VrPUhTHIiyxar5p+Nb13wNax51R9i1byzMZBEH/L46b8XN47ASX0nZBtdyiZXolquHaXQhkfo8+kvcSVMhtYe3OiRGQNHAoA3XL9yVkD0wBRoYRBYjoHzfCNVqqT45fM+h1MGTk4SLsL6PXfiv7d+ExvHHsZIMIqJcAKhjVDXNTS8BubX5uF188/BFUvfhBUp1s8GX33iv/F3Gz+KjglQ0xVEiQFEHGEsGEOP34PZ1dn48CkfxMVHXJBRuEGED977YVy97VsIOa6reKRzYxLGgnHUvTpO6j8B/3b2RzG3NidJlgm723vxGxt+Bw+NP4KODTDg9zuNRPEu+OpZp+Izq/4VvX5v1qH33advw18/8A/YNPl4VifR5OGEvuPwa8f9Mi5fcllmmH+38aP47KYvoMfvSfpruGDIFvE1ffOCr+LI5tKsI/POPXdh7f1/g5HOCCKOMJLMW6nrOpY1l2JwwXn4mWVvwfyEvAkAX9/6TXzkR3+Njumg4TVmDAfTLslfPPrt+LNXfzhTqOkabHfT2Tb9FNpRCxCCE4oU5tfmoc/vxW/f/UF8+6nr0Ov3ZsaoEqX/Zc0l+OyqT2BJc3FGz5fcrJgwOoK9nX2ZASHJnxq6gSMai/Dt7dfi977/ITS9BgzbfGdrTlCdTb3p6d7Q3nXT2JJz1gyt4LUzIFeHZiAABm8Z9NZdsC4avGblB9Dr/+P4aGg4Dv0EpTiuR8ytzsN/v+5LmJ1I/chXxwYYD8axbWobpkwLsyuzcERjUaboDsSKIN99+nZ8actXcOe+e9Dr92YERAIh5Ahzq7PxnuN/FefNW3lA8YWdrV24ffd6/PPDn8S+YAQVFVdy51Xn4jdPfA9WzT2rgAzJ17ap7fj6tv/Fvz362UK4lYoYnDpwCtae9sc4ddYpOZTqvpH70U4kf/r9fpwycFJ2D+54+g7808Mfx/2jGzFQ6c8IfeV99gEWNRbhm6u/mrEIZMiyv7Mfhi02TWzBgvr8rCmsu2Mb3L7nTnxm0xdwW9KpmN7PZ0K+RoNRnD//XPzJqX+Q0delJzhQDnLLru/iC1u+jLv23RszjQvdmArTpo1ZlQF85NQ/wiVHvN45PpeKA3Yh7s34zKYv4PodN8Ak7029hyswEveBsO1peGqOpYu/efFtN6Vt5s+LgQAgrAGdes6p9dnc/MG4omNtxzIRFDvcK8vAnOosnNh3PE7oPx4r+k/C0sZizKvNxazKQOGmToQT2NV6Go+MP4bb9qzHnXvvwdapbdDkZQlrenMVEaajNk4ZOAnvP/HXEdgQD449hJHOaE4ULuII86vzcFzfMfBVBX9+/99g5/RO1HQNU9EUTpt1Cn7zhPdiIprEfSP3J4INKutjjzjCMT1HY1F9IXa2nsb/e/AfS6dSadKYiqZQURVcvuRSXL74UhzVswwL6gtyu2xgAzw09ghu270eN+z4Dh4aexiU9E0cKKmP++ynsGreWfjCuZ/KGceTU9swqzKAPr+38Lknp7Zh+9R2/GD/j7Du6dvwo9EHYNiiL9nFDxZy16QxEU6ix2vgokUX4A1HXIgT+47HovrCLP/iBPl6anonHpvYhNv2bMAduzfgicknQUTo8XoOwIOLByoFpoMz55yByxZfjNfOOR1HNpegoqpydCv2d/bj8ckn8P39P8KtT38PG0cfQse20ev1dsWnnUao7obFptbj62Y7+tYtl224Yg2vUQfjPQ7FQDJhh/OvO+dttqa+NjkRGgJpCJ3TVGG7YyO0TQfGGnhKo6qrmF2ZnVW60xurQJiMpjAWjKFtO7BsUdd11HR1RmU+SjzVRDiRsJdQbIQXqImFxYDfnxXTshArHE866g78eUWqdBG6Ci1x3qEwuzoLA5WB3Lm3TAt72/vQth3UVBX1ZJTDweziI8Eofnn5O7DmtD/MwivDBlfcMoTRYAx9CQqVGQ8R9rb3YjKaQmDjpLzhNZ6VUky3gm4wGU6CSKHf78P82rwCfPt0azcmosnkGdZQTbQEnukaU9WUqWgKoY3Q8BpYUJufzZ5Mrytl66bARkPX4CmdtEY7EwkE1Z0AJgWeXdfREcqu/OLg+h8ODQ+pg/Eeh2QgqZFcNTRsX3/9ypumq96FranQAKTTyVLp38jQqmSXYYuQTSlXKe0S60r02IMi3h0KdcUUkKFD+TwftC4WJ2MaXORFkcoS/kOR5Exzgb87/c8xtOynEdoIvvKws7ULV9xyJaacvg5ZqZZtsc/HwNK0qzIqmUIMxC0JUq3mUBUbU0jXskFgw8LnPfLgKa/rudJrIqGe6BiKAmAsm9mzK7oxbf71mjfc8ZsHG1rNyOY9iPI+X34Tfj+y9q5pIpAFJwLv6E6+5UzUOnto5AHKy19FqnaX1AMOpeD0XGYMPtfPH8gINWlopQvzvp7Nd6aw8rKsSSo+6FNTT2EinMxrFDtFgOd7im8msAHKvIP8vud6T+X5VlQlv9Kp/Jqkwk5ZeGUY1q8q5beiXXOosQYMGsbwId2YQ2IQDl85bIZ4SH/r9Ru+H0ybj/f2+ZoTU7bJlCl0Zy0UHnYWXjl/4xUlOC6u7zleY9Zn33D67McfQce0c6ohWffeC3xPU67dC/l9B30PnUIgu/MLwbZR12Qi+0dfvPjmfUMYUjhEgX91qCc/jGG7hqGatehP6i3zZK2mlWW2cCQeD7/wnJXhAxtgcX1RFvN3++wfL53PiJ/A8Qe5HnOW/SFsent9z5uObv7OZXd+fuiqWEr0kJ8DDp1gyxuHh+imi+8dM2x/S3uUG7tBh5rYHH7NcJtjIYqje45KFNJN1sj1+OSTM0qF/sTNSU+q5ZGoeSiAlaeAwLbmevb9AHjFDHT2599ARKj1nUs2/K/XMV/t6fM1mA2eM9/z8MsNsY7uXdalmBChFU3jqekduUaun1gHwt1ZNZqkJC7besPTDct/Nvz6uzYOXTWkDxbWfV4MBACGPzLMWLNGzemj91c7ZqdXUUqlKvOHreR58CAEX/k4uf+kHEv56dZujAajz6gaj5+gSbeUVy8xfsPTejJc36lW/j5BrZ41YvGsDQRrYYdO3khfP3f97pbBr1V9RUxgy4djrOdjqtJkNAkGcFxvvrtvR3s3nmrtihUKDzBF6ifjXhXkcFl7hB7mVq2q373ugnVRElo96y37ObWJbRzeyIO3DHq3XXzbw8uuPGJhpb9yVtg2aVn68OtZeI3JaBIWjKOaS/GzR/00Xr/ogiS8SlsJKtgfjGAiHMfu9h4opZ7Xbr+X2Q3LYN6EVW76ej3Pb5vfuuEN668dXDPoff6Cz5vnOm/muSIJNDQ8pEaPH62FuyY2THr6lM50ZOmwkRzKmO+MVvKuY38JP7/8SgHtzvz6wf778Pv3fhg7WrtQ0T95OYlU+Iwsm/5+X/e0zX9ff8n6n0kH4DzX7/Ceh7PkFbyC19LaqXfcfO47nrB8h/VVjaO4cUGqL5LbT8z5cb4sZq5LdcayRhiV9MbLRplUcsj9bPpdcmKW/E6nHtWVjXH/Lb6XkGNq5jSJLedRFnYqvulkLk2ATujlmoCq1tje2ob/3PJlTJsWjM0TArt4fzy+oK4bsDBZqKGcycTpOWsQItHDXyZcJmsJmmJUSJXcf9ewWShqus+Rufy5kxAZzJ5FqohTInMLZ3KtfDYcC1nbSk1rr2Mfn9PQ716zBmothu3zZYTPyytl/F5wzap3Rk39mamJKOLEACMudnxlI9wcBQpF+f+XRiNvrFOMLwyFJ0eaSOWaeYR75vyD7iJIxSH0EjVxF5VyHjpKDFAnPws5pY3Hn0mNBSBMRZMIkv4IBoOSIXpZV1wSboFjblVfpReavKwvgR0m60yrWt5n+VC00DXLiT+nA5Q4397qPjeIWTFyLJ8V908+o1Lks9BGEf/bcOl5se+RrXhkucOr11++/o5DpZO8KAYijeS8a1Z9wvbq906OhJFWMUFHUpC55AGwuDFyISvJsRFcfzkb0ZYsAiqZja2cHT59qMZpsjGc62HOTVl1d7P0uEosHnKux53nKBddtpgSY9KqZIid/JyzQTBbGFdqs8QTk1iYzN3NQHpheb9zw5KEQbP0oCjShrIJs875sjPoVb5POZua3IjkfbLiuoTRRs1+39MTwftufeOdH0/X4PMZxj2fQTUNDQ8prHhQb9/efzPV9HmT46HRirQRN0VJ+VIhOCeV8shZyNYJa9ybSCWzstOHmn7eOt5Ki5tupe6XwwqQwnjW5QClxkU51Ywc5UElCn/G2bGz63UevFwouTmRM4Sc7sO0nPeI0rtGYjYfUZ4BS877s7BULvoDhcFi5JkbqhKcWeUli11uHvJz8viUJyJGA7Mrnj8VfeKmS9b/xvNtHM8N5p0pHxlawcOnbAxChD9fjczW3qanbTK4wnIJoUwsVulCrTMXO1WrUAA8MY+bxQPpSg/lXXnE3V2PhQeQ80ykKF66cK3QWbLiQbIjlgcAoe3+HOLhquTfRngaN0SUXobEApeiA1bcm4KyDJdPI2ahESW9W9n4CjijAqx4P8TMcTiK6TmPKBdyiWGzc/9J3OPctICSkNwdwWEsR81+36Op6KaROcFvD101pMukQ19aBgJgLa21Q1cN6XsuvWebmaa3E/OU9uPB6VqMxWInIeOu6l1hV6RChZlzYhF2BneY9Sg7Oq5qhuPKhyWNLN0J2dm+U8kj40rtS9ImFfMSJSBKTeUJsBILn1B+fNeFELq6Zbrkew2XDziSG4vcjFxSoOz9kQk5CUCCxDm5oJoVrp05fyx2Jyhz/n5Qzhux0XXt6cA8prR9x72vvTccfnCYD5WI+GMxECCmogzeMuh99813rPdD8/M9VaV0PBiImfNjE+RCdnuX5O7EIo5nZzgKi8E97PxRTtxMgh4td0ppFEYIkVkJDFB+ASQzJqDI6YOWfzuyM9n5Ozu7DAFnCqnILYxRPg1g4ZXljkwOCGGF4kfO20iFTCchTsNjaXjFYZjFHJC7k5y6IRx1DZKEQUovl12vuGYmwFq22td6jqL9S9i+6Tuvv/PpoauGtDu24CVtIACw7oJ10eAtg94tl935TWqb9/c0tNYKRhNYiQdlBXRLKMKmisq9g0SMFBVdAjlhiSoLBUpuhEXeGNxQQe6oMp0OrZNXCG6QcsMLsSnIXdbdVckZUiSFCHiGEEf+Q5PbepqXxclBsmnSe4AFKg3UHZIkQ0W54ZV5a+a8Z4ATXqYbFbvwsGWu+Ir6PUwGQfS2/3rDnY89n4gVnu9K+jO9nvz8k3bwlkFv3Rtu3/Cqn1tiox7/oqhjjAYpRlEz1W3fpRkKQwWUA07i6RzDcvnuS07tI5f8c77+Qc4CTaUtM3iUipL8ZRk1UTEuh+PBCnitQ86zTqjkLjJ39DEo7wXSDcDNJeSAVjcxV2LGBkQI53oYSGie8t8NLoZMSMJUsONl5LNIBKeVp3h2TVGPMT99/aV33jh4y6B3zeXXGLzAxcgX/JWiCyu/vfJfqdf/jamxIFJEnotvy7Akd/NFSKTlkB43Hkax1uLCy+x4C3ZQJWkIcqFKRImcYmHZ8SVUrEThLb3eXK1CeAXlhGVuYUwWAV1hZteYbUlu5EKqhBIIVtwfj4rnIw2VXaMsQelYAhfi3N3rzdVJZITAYKWJ63Wl0DLv+t4bN3zmhUCsXtQQy9X5HbpqSG9404b38VT4qUa/7ykgspxfLHIXLUvwyIm53VDEjf2tg+LI0MsKuVQldlR2DJSElRonNpfnYJ1YXoaRkYsmsWOslEf4bFn8D4fWTflZ9VbkMsYNy9yRFZyHY+XFqJLqNhwGAqfXJPMJ5D23EhsfSvJLhlPDggPxppECg5UGV6pKtafNr7+YxvGiGQgIPDw0bNfwGrXhsg3vUVPRp2p9vgdwRM6is85CYEFGS3duw0WoUjmQKDnVbCWyxlTwGFSsmxDy4ZPcFd1dPKOwcD45dvMeea4yJqcSTpFFPhSUQIYEAly0T94jCRuXedn0l7nZGbKyTnlPLsGE9NpdpEvmboYdD0f5qrtsdKKSaxWbHlsFrte00m3z63e/acMnX0zjwItOTE8KicNXDpvzrlv1CTS9906NhZFhaE0g68SeVrp8SkSyKY+V5yrdTpyb/ttT8XGM2BVcqoN07xEXF7hFeRWYHFAgl+tQOb2CS47lMgZS1MmI3VeV0GeMW73mPMoEsbuTcz0ujYcPVH0sSbKViNNk2AqXq5aca8TFhJ5LgJOEUmOhiGo1TV5g3nv7ZRv+7cU2jhfPg5R4ktsuXf/reir8555+39METkWxczd6BuTD5eq4Vdjc7wiIbHdBZEU/Lp/7zgB8la9Cy107BxJwvqruFkNdSocbSygnsVcuKc8JPeQuDrFLKwc2l16NBFmyLERUDk8NIkmHqHOA85uXcgzJyk2HiuiaLSnfGC63RQKs72s1t665N7Tv/HEZx4tvIImRrMVaXsNr1LpLN/x2f2D/pNHQCrFuvDUimSQBNZIsClJ5RxmVJORu5i5zDRm3g/NIUPoAJd1F8q5IVOMjLsjNdEMwMYGLHfqE5Tw/zIphMOTcA8rqLVSI2WVeA1Fj0DRzwVUSLI1buOOiQoi8dslykEVUmYcYkedZLq/tkEhqMsNlNuwr1V+hiTnWvu2mS9d/7sdlHPgx9/7R0FVxuHX+9St/1fP1v48HjDA0RlPcAWRnQHXYSfz4ABeVFph0bkZEPjxy4VuJ0LisXBefl5wilKBZjFIpsLynKemOk3BujrfE5dRvlNDYZZ0oG66KosgaH4CuT054VojCxIGUg1Cxew+79PQC7d3GxhHVGp5XZd7HbX7z9y5ff8eP0zjwUmiOTW/AFdetunyfps93iGZH01GEhAUsQy4tCovuQnGZoDKOZwc14RImsFy4PlEyBbakvwPFijwc0WTlUPxlLuBeRxlpDyXDYAo1C3GtxmXPoijibLhYf3CNP+t3EaEXAYicWpVCOc1doomeIoTMpa0MbsE2CdeiRp/n2cA+3Ozg5268/I4f/riNAy+V7vH0Rqz6xqrX+E31Xx2fTggmwsiCvDKtLdmzUOjR4Bn6luFQQcryD4cGw271umQHprLeEe4uxDJauS3xhjNpirFT/FRUrIbbMpqOZL1yOcvAhZFl2FUqsSMM2LpIovAEEPUql54P5x4bC9YKtt7r6Z7Q3sxj/PM3vm397uerI/AVYSDSSM745hlz69XK59HQb5wai2yy+yopZV+GGMkmHXbjfXKKkMhTthUVw6z097nd3qXnlxyPnZ4UO8OOLkMQj7qLmEqipVLqPxUp8TxDrEklhUd3N3dp6W53p3IKkGWG47YIuN/j1j+I2WqtVH+PBrXMJ2++ZP37ANgXmj7ysjQQoKsgDwCD1636G1NRHwxDi3ZgDUA6V4WmmfsfuIRflVfd6+7o8ngK5Q1PsrchjaFTukVZHcU6aI/UjlUuI7ak6FjYdUVB0ViHeOgUJhlFnhg7GwEcw1coDpyBW2lHuUA0lfC04OQXyimkxn04HKGivToh6CH+wI0Xr//4mjVr1FqsxQtFPHzZG4icaAUCD16/6meUok+0PDW3PRlGRKSJQJEtcrJcdETSUmxJh5rbLKSdQpYMj+SCMM7inammUsiPXJlMUdwDFyvyskdGO9wpW9I9ySU9E25hTovWAJWNmM7XewyX523yvmbzKUvYyrqkZuQ0c7FhtrNnVXQztJtsh995/WV3fG/oqiE9PDRsXwjK+ssL5j0IGBiUhFyXrP9aa9qu8kJza99AxasoImthPTUzoqKchih3frZkrxKKvSLsFtucAp9LokxDE+tAwmUCeiQ6G1NGQCqbaTKZ/y4jlpyKvSkpgpY9yLICXHY/XHaCE9ZRCfKm3HyN85QW6TWjstwmM2w2WhP1D/ia2mY4GrHnXn/ZHd8bvGXQG75y2LzUjAMvdYm3LFG7CvqyOav+tAX64wkLHbRM1usOh1iYdQOim0OYMr0dFEMsT9Ak5G7rVtOVsygKTGGUhyRKCFUAeWaARNZMIjdj3J72EsBAkhBdeFlSx43Nd0rqEni8bISAdfrNgSLq5XLiXFYzM5jAptb0vJrl6QHFH/rGhes/6obVeIlKC720X2ug+CNgIvDrrjvnAs/Hv5qKPmlsNGTLzFqRsmKr9BzJntTtc0kI4CJXLupU1n3nGkzOAGdIbAsddZSHhnVJqOLG/mV0F7i5jPCansovVmOL0Dan589FkqItoYBo4QHLWg5QYmCK2DCU7u3zoDtmQ7uNX7/j8jt+uIbXqLVYyy9Fr/HSDrFQlDglinea7156xy3H2s6qnk70sYG6olrTU6HlCIibsFJI0zq7PZd4AblYtcOmzZElna47chJ/KyrCqkx4QVAqcm2wwkPZQpMOFQiRBnmYmZzOPBYLXiqsuOxYRkldyKF9uAxrOM1bStZP2MmzuoxhZmbj1z3dU6EA7WjtnP2jg3ck9Y21tNa+1I0DLzcVXemOL7t51YVtVn8TVNRrW5MRYK0hIu0S/VxioC0h9cGlWFNeDG0mVEdqa5FTFERJ31N6TOMgZZIaX1aRL6vt2BJpIslLkzR1VZKPyTqFVHdRjmekEuZBKdiR6z3hSHvKazQ1KLC3cWR/73uXbrgLANYw1Fp66aBUrygDcRnBZ/zbGX7/MdUPdCz/EVf1QHsiYgasArQpQbUkHJrjcjkxdbrrepQXtnNRHSvqLlQSdrhFvgLtgot98OQUPRUVxeBcvasyaBUOrOuia6pE3bCs74NKoG8350mNTBGMZah6r0+qY/bVYP/ipts3/DPWwiZ1LvNym5DxspUGz9dMVh7b8NWHLdEvjROhMxnZJMxSbucaSnSvdMkilhVyT/RP5JqZSqjiytH5Qkm3H5VQXxQVOxIVzcCDKqGjFGHnRKS0BERwuxfdIayaCIY5p6gYlYm9ZfKpsBZArcdT1dCyr/HpyUn6y9vffPtWELDGHvzY5cMG8jyf/+Atgzrl67z55lWv6xCtmSS6MDRA0DZGJUTYAtIilcEdTVrZM+LytQqoVkKGJMdblOn2GgfhcWsJZdKrcJRGFBURJlmZ99MGJye0VDPkZe7oZLcN2NXf7eZoBGPZVhSgalo1NaFi+HpE5s+vvWTD7QAwuGbQW7f2x8ul+kk3kAzpGjp5iFKPsvrGc95GwAdtRZ01FTI608aCmBVIS+nStJEKDkXE5RlZh4FKjn4tO7F4bmEhX6zkGZqmygSilWNUbqekLeE2cZlyvICI0/xK9obIUCyDuks2hG4xk41mokpDq6om9Fher6z922+9fv03Mu/+4DC/lCriP9kGIsOutBq7BuqCc1f9LAi/F2p1RsBAMG2sImbmeEqNSkOJEoqFdqjxhV2X873r2hExsCVSNq7Or2QbYwbdYlsSwqVdjx6VC0mnn/EoVnV3G7pcLyX7WLRDqLTdfIwJbImI/LpWHhFMYO7ShL+/7Q3rv5YMp6U1WEMv13DqFW8gZfkJM+gNN6x6G3n020bReR1FmJqIwMwRESkClC3RYZa0cOsQAnPJK+XDFsIBVECEBbqFyLLiHDmiDnDacCWKZbg8HwGKtY+y9hGJ9xvZN89gAzZE5DV7PVQMQxn+LjF99KY33P719BAv9YLfYQM5QENW+oM333Le60cC+24Gv9XWdSVsW4SBiYm0TEolffFcwkeixNuUQbDa6QHPioclzUOe7BsRckCuYINLnWdnsXtObmRQTKBl7cMjR7+4ZCxBmoMxgzWxBQier7SuKXhtG/b5dLVH9G/fvOC2m8o2o1fqkJ5X/EsMcmQAuPSms1a0rf5lgK6MqmpZ2zBMy8BYjjxFZBlKoWssruhalpg74dgzUTa4pP/cOoxel8ruOSJwjCJTlksqv8YZrTCTCLQI+diArQLY08rz6ho+AX7H7LCg/6qA/+PGS9Y/4ELt+AmYYvUT8xq6akivGFrBaYx87DVn9S3zvSsU4ecCgwtVQ9enAwvTsQiNjTSBCKRMvk0kh3zJMMWW1C1mDLscaUs7w7wU6cnKhvhQydzwyKl2y45M2exkYo6UtQz2NHmVmobnE6hl2lVFNzY1vkrkf/vqC9aNxkW+NWrj8Eb6STCMn0gDyUCvNVAbPzJEsmNt6I6Vx45N68tDa38ajJXc8PxWyAg7BsZYAwYzSMVGE5cZJOxZNmXKcn7ojBJkRHJFHpD3TihBzbQUp+ZiDwgcSr1Bvl6RsUGYrQWo6imtqgq+R7DTkSHQhh5N/6OgvnXtxbc9miONfuSVgUodNhAcelV+xYPDvFY8/MtvWXViEKpLJ419Y8R8pq7pAaMIYWARBRYabAyDFYHApIhAmZIg5+U1UdKMRE5l3O3YwwyUDjrAwByIENBLjC20cTMlEVvDIE2kyVeo1hQ8BqhtppSiO2sa32qCbvjvi25/sLCJYPhlwZk6bCAvgle5dfWgWrd6Xa4v4ZJrz1/UQrBKk76oAz5fM04MasqHIpiIYQILjpgZbGK4lchyXDbxkjk/doYW2jL42G22mol+4vTBMFMinsPgOJEnpTQp8gnViooNctpYC368z1e3w/JNhtS6my6+favcMAZvHdTrbl1nfxK9xWEDOURjWX3rOis9C/Ma9bZ1txyzazo4SxGtVMCZVU3HTQCz/boCgxBFDLYMG1qwjRUCExYuWwB+Mvk38RyUSIpSx4rRAflCYWI3DAJBEbMFUFEEY2MwjBXFuYMmkEeoK8J026Ie2WkF3sKge3o8ul2zvfPCZQOP/vbx13Vco1i9ep19OZEIDxvISywMwxBQprJx0f+cOSfq8Y+uM508asypBFrR1FjctlisCP3sKx0BIE0ILUMn+UZoGWwBshz3auTGknXTeZ3w15UCmAlGARVNYMvwGTChhbU8MeDRDgA7JyM8MuBjY8figZHp8LHv//Q921yVkqGrhjQAvFKq3YcN5CV0v9asAd26elABwIzsVAa95upzFi3vxxHThpd0DBYz6OjA2saAp06YNtwwDGp6mN0ymG0sGgYcexNFZBgIDKOmKFIKkww8bZmnm4q4bbG5zdijwbsYvKkG7G+H3pYjlo/sGj5lY4AZFGMAYPXq1fbl0KT0Unr9/9ysVHsI9ztpAAAAAElFTkSuQmCC" alt="Shopee">
      <div class="header-text">
        <div class="title">SHP 自動回答チャット</div>
        <div class="subtitle-row">
          <span class="status-dot"></span>
          <span class="subtitle">接客担当専用 ご質問受付</span>
        </div>
      </div>
      <button type="button" id="staffIndicatorBtn" class="staff-indicator-btn" style="display:none;"></button>
      <button type="button" id="pushEnableBtn" class="push-enable-btn" style="display:none;">🔔 通知を有効にする</button>
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

  <div id="staffGate" class="gate-wrap" style="display:none;">
    <div class="gate-card staff-gate-card">
      <div id="staffPickSection">
        <h2>あなたのお名前を選択してください</h2>
        <select id="staffSelect"></select>
        <button id="staffSelectConfirm">この名前で始める</button>
      </div>
      <div class="staff-manage-empty" id="staffEmptyMsg" style="display:none;">まだ担当者が登録されていません。<br>下のフォームから最初の担当者を登録してください。</div>
      <div class="staff-gate-error" id="staffGateError"></div>

      <button type="button" class="staff-manage-link" id="staffManageToggle">担当者の追加・削除</button>
      <div class="staff-manage-box" id="staffManageBox">
        <h4>登録されている担当者</h4>
        <ul class="staff-manage-list" id="staffManageList"></ul>
        <div class="staff-add-row">
          <input type="text" id="staffNewName" placeholder="名前" />
          <input type="text" id="staffNewAccountId" placeholder="ChatworkアカウントID(数字)" inputmode="numeric" />
          <button type="button" class="staff-add-btn" id="staffAddBtn">この内容で追加する</button>
        </div>
        <div class="staff-add-hint">ChatworkアカウントIDは、Chatworkのプロフィール画面に出ている数字のIDです。</div>
      </div>
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

  // ===== ブラウザのプッシュ通知(タブや画面を閉じていても回答に気づける) =====
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function setPushButtonState(state) {
    var btn = qs('pushEnableBtn');
    if (!btn) return;
    if (state === 'on') {
      btn.style.display = 'inline-flex';
      btn.textContent = '🔔 通知オン';
      btn.disabled = true;
      btn.classList.add('push-on');
    } else if (state === 'denied') {
      btn.style.display = 'inline-flex';
      btn.textContent = '🔕 通知がブロックされています';
      btn.disabled = true;
    } else if (state === 'unsupported') {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'inline-flex';
      btn.textContent = '🔔 通知を有効にする';
      btn.disabled = false;
      btn.classList.remove('push-on');
    }
  }

  // ログイン後に呼ばれ、対応ブラウザであれば通知ボタンを表示する。
  // すでに登録済みの端末では自動的に「通知オン」の表示にする。
  function setupPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      setPushButtonState('unsupported');
      return;
    }
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) {
          setPushButtonState('on');
        } else if (Notification.permission === 'denied') {
          setPushButtonState('denied');
        } else {
          setPushButtonState('off');
        }
      });
    }).catch(function (e) {
      console.error('サービスワーカーの登録に失敗しました:', e);
      setPushButtonState('unsupported');
    });
  }

  function enablePushNotifications() {
    Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') {
        setPushButtonState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      return fetch('/api/push-public-key')
        .then(function (res) { return res.json(); })
        .then(function (keyData) {
          if (!keyData || !keyData.publicKey) {
            alert('通知の設定がまだ完了していません。管理者にご確認ください。');
            return;
          }
          return navigator.serviceWorker.ready.then(function (reg) {
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
            });
          }).then(function (sub) {
            return fetch('/api/push-subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-chat-password': getStoredPassword() },
              body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub })
            });
          }).then(function () {
            setPushButtonState('on');
          });
        });
    }).catch(function (e) {
      console.error('通知の登録に失敗しました:', e);
      alert('通知の設定に失敗しました。もう一度お試しください。');
      setPushButtonState('off');
    });
  }

  var pushEnableBtnEl = qs('pushEnableBtn');
  if (pushEnableBtnEl) {
    pushEnableBtnEl.addEventListener('click', enablePushNotifications);
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
  var STAFF_KEY = 'shpStaffIdentity';
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

  // この端末で選んだ担当者(名前・ChatworkアカウントID)は、毎回選び直さなくて
  // 済むよう、この端末のlocalStorageに覚えておく。
  function getStoredStaff() {
    try {
      var raw = window.localStorage.getItem(STAFF_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && obj.accountId) return obj;
      return null;
    } catch (e) { return null; }
  }
  function setStoredStaff(staff) {
    try { window.localStorage.setItem(STAFF_KEY, JSON.stringify(staff)); } catch (e) { /* 無視 */ }
  }
  function clearStoredStaff() {
    try { window.localStorage.removeItem(STAFF_KEY); } catch (e) { /* 無視 */ }
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
  var staffIndicatorBtn = qs('staffIndicatorBtn');
  var staffGateWrap = qs('staffGate');
  var staffSelect = qs('staffSelect');
  var staffEmptyMsg = qs('staffEmptyMsg');
  var staffSelectConfirm = qs('staffSelectConfirm');
  var staffGateError = qs('staffGateError');
  var staffManageToggle = qs('staffManageToggle');
  var staffManageBox = qs('staffManageBox');
  var staffManageList = qs('staffManageList');
  var staffNewName = qs('staffNewName');
  var staffNewAccountId = qs('staffNewAccountId');
  var staffAddBtn = qs('staffAddBtn');
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
    staffGateWrap.style.display = 'none';
    chatWrap.style.display = 'none';
  }

  function showGate(message) {
    clearStoredPassword();
    roleSelectWrap.style.display = 'none';
    gateWrap.style.display = 'flex';
    staffGateWrap.style.display = 'none';
    chatWrap.style.display = 'none';
    gateError.textContent = message || '';
  }

  function enterChatForReal() {
    roleSelectWrap.style.display = 'none';
    gateWrap.style.display = 'none';
    staffGateWrap.style.display = 'none';
    chatWrap.style.display = 'flex';
    renderRoomList();
    renderRoomDetail(null);
    input.focus();
    refreshRoomList();
    setupPushNotifications();
  }

  // ===== 担当者(名前)の選択 =====
  // 質問受付ページを開いた人が誰か(接客担当の誰か)を一度選んでもらい、
  // この端末に覚えておく。回答が来たときにChatworkでその人にTOを付けて
  // 知らせるために使う。担当者の追加・削除もこの画面から行える。
  var staffListCache = [];

  function renderStaffIndicator(staff) {
    if (!staffIndicatorBtn) return;
    if (staff && staff.name) {
      staffIndicatorBtn.style.display = 'inline-flex';
      staffIndicatorBtn.textContent = '👤 ' + staff.name;
    } else {
      staffIndicatorBtn.style.display = 'none';
      staffIndicatorBtn.textContent = '';
    }
  }

  // 担当者が1人も登録されていないときは「名前を選ぶ」画面自体を表示せず、
  // 登録フォームだけをはっきり見せる(選択と登録が混ざって分かりにくくならないように)。
  // 1人でも登録されていれば、通常は「名前を選ぶ」画面を出し、登録・削除は
  // 下の小さなリンクから開く形にする。
  var staffPickSection = qs('staffPickSection');

  function populateStaffSelect(list) {
    var hasStaff = !!(list && list.length > 0);

    if (staffPickSection) staffPickSection.style.display = hasStaff ? 'block' : 'none';
    if (staffEmptyMsg) staffEmptyMsg.style.display = hasStaff ? 'none' : 'block';
    if (staffManageToggle) staffManageToggle.style.display = hasStaff ? 'block' : 'none';
    // 担当者が0人になったときだけ、登録フォームを強制的に開く(他は、ユーザーが
    // 自分で開閉した状態をそのままにしておく。追加・削除のたびに勝手に
    // 閉じてしまうと連続で操作しづらいため)。
    if (staffManageBox && !hasStaff) staffManageBox.classList.add('open');

    if (!staffSelect) return;
    staffSelect.innerHTML = '';
    if (!hasStaff) return;
    list.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.accountId;
      opt.textContent = s.name;
      staffSelect.appendChild(opt);
    });
    var stored = getStoredStaff();
    if (stored && list.some(function (s) { return s.accountId === stored.accountId; })) {
      staffSelect.value = stored.accountId;
    }
  }

  function populateStaffManageList(list) {
    if (!staffManageList) return;
    staffManageList.innerHTML = '';
    if (!list || list.length === 0) return;
    list.forEach(function (s) {
      var li = document.createElement('li');
      var nameSpan = document.createElement('span');
      nameSpan.textContent = s.name + '(ID:' + s.accountId + ')';
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'staff-del-btn';
      delBtn.textContent = '削除';
      delBtn.setAttribute('data-account-id', s.accountId);
      li.appendChild(nameSpan);
      li.appendChild(delBtn);
      staffManageList.appendChild(li);
    });
  }

  function fetchStaffList() {
    return fetch('/api/staff-list', {
      headers: { 'x-chat-password': getStoredPassword() }
    })
      .then(function (res) { return res.json(); })
      .then(function (data) { return (data && data.items) || []; });
  }

  function showStaffGate() {
    roleSelectWrap.style.display = 'none';
    gateWrap.style.display = 'none';
    chatWrap.style.display = 'none';
    staffGateWrap.style.display = 'flex';
    if (staffGateError) staffGateError.textContent = '';
    fetchStaffList()
      .then(function (list) {
        staffListCache = list;
        populateStaffSelect(list);
        populateStaffManageList(list);
      })
      .catch(function () {
        if (staffGateError) staffGateError.textContent = '担当者一覧の取得に失敗しました。もう一度お試しください。';
      });
  }

  // パスワードでのログインが済んだあと、この端末に覚えている担当者が
  // まだ(削除などで)有効かどうかを確認してから、チャット画面に進む。
  function ensureStaffIdentityThenEnterChat() {
    var stored = getStoredStaff();
    fetchStaffList()
      .then(function (list) {
        staffListCache = list;
        if (stored && list.some(function (s) { return s.accountId === stored.accountId; })) {
          renderStaffIndicator(stored);
          enterChatForReal();
        } else {
          clearStoredStaff();
          renderStaffIndicator(null);
          populateStaffSelect(list);
          populateStaffManageList(list);
          roleSelectWrap.style.display = 'none';
          gateWrap.style.display = 'none';
          chatWrap.style.display = 'none';
          staffGateWrap.style.display = 'flex';
          if (staffGateError) staffGateError.textContent = '';
        }
      })
      .catch(function () {
        // 担当者一覧が取れなくても、質問自体はできるようにしておく。
        enterChatForReal();
      });
  }

  function showChat() {
    roleSelectWrap.style.display = 'none';
    gateWrap.style.display = 'none';
    chatWrap.style.display = 'none';
    ensureStaffIdentityThenEnterChat();
  }

  if (staffSelectConfirm) {
    staffSelectConfirm.addEventListener('click', function () {
      if (!staffSelect || !staffSelect.value) {
        if (staffGateError) staffGateError.textContent = '名前を選択してください。';
        return;
      }
      var selectedOpt = staffSelect.options[staffSelect.selectedIndex];
      var staff = { accountId: staffSelect.value, name: selectedOpt ? selectedOpt.textContent : '' };
      setStoredStaff(staff);
      renderStaffIndicator(staff);
      enterChatForReal();
    });
  }

  if (staffIndicatorBtn) {
    staffIndicatorBtn.addEventListener('click', showStaffGate);
  }

  if (staffManageToggle) {
    staffManageToggle.addEventListener('click', function () {
      if (staffManageBox) staffManageBox.classList.toggle('open');
    });
  }

  if (staffAddBtn) {
    staffAddBtn.addEventListener('click', function () {
      var name = (staffNewName && staffNewName.value || '').trim();
      var accountId = (staffNewAccountId && staffNewAccountId.value || '').trim();
      if (!name || !accountId) {
        if (staffGateError) staffGateError.textContent = '名前とChatworkアカウントIDの両方を入力してください。';
        return;
      }
      if (!/^[0-9]+$/.test(accountId)) {
        if (staffGateError) staffGateError.textContent = 'ChatworkアカウントIDは数字で入力してください。';
        return;
      }
      if (staffGateError) staffGateError.textContent = '';
      staffAddBtn.disabled = true;
      fetch('/api/staff-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-password': getStoredPassword() },
        body: JSON.stringify({ name: name, accountId: accountId })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || !data.ok) {
            if (staffGateError) staffGateError.textContent = '追加に失敗しました。もう一度お試しください。';
            return;
          }
          if (staffNewName) staffNewName.value = '';
          if (staffNewAccountId) staffNewAccountId.value = '';
          return fetchStaffList().then(function (list) {
            staffListCache = list;
            populateStaffSelect(list);
            populateStaffManageList(list);
          });
        })
        .catch(function () {
          if (staffGateError) staffGateError.textContent = '通信エラーが発生しました。もう一度お試しください。';
        })
        .finally(function () {
          staffAddBtn.disabled = false;
        });
    });
  }

  if (staffManageList) {
    staffManageList.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.staff-del-btn') : null;
      if (!btn) return;
      var accountId = btn.getAttribute('data-account-id');
      if (!accountId) return;
      if (!window.confirm('この担当者を削除しますか？')) return;
      btn.disabled = true;
      fetch('/api/staff-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-password': getStoredPassword() },
        body: JSON.stringify({ accountId: accountId })
      })
        .then(function (res) { return res.json(); })
        .then(function () {
          var stored = getStoredStaff();
          if (stored && stored.accountId === accountId) {
            clearStoredStaff();
            renderStaffIndicator(null);
          }
          return fetchStaffList().then(function (list) {
            staffListCache = list;
            populateStaffSelect(list);
            populateStaffManageList(list);
          });
        })
        .catch(function () {
          if (staffGateError) staffGateError.textContent = '削除に失敗しました。もう一度お試しください。';
        });
    });
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

    var selectedStaff = getStoredStaff();
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chat-password': getStoredPassword() },
      body: JSON.stringify({
        question: question,
        staffName: selectedStaff ? selectedStaff.name : '',
        staffAccountId: selectedStaff ? selectedStaff.accountId : ''
      })
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
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAUMklEQVR42s2bebBcVZ3HP79zb69vzb4nQoAAIgRCEsQCHKdQpBDHcRIdMQPCIDgIjAsjQfERrUCQAQuhBhdGHLQQE5VVmVJHQR0MCQPKEggBTEgIWR95S7/Xy73nN3+c06+X1/2WgDN0VVd33773nPPbv7/f7xzhTXqpIlxDIKuIKlcF/XrrAqxdjI0XEXM0yjzQKVjagABRUImBXgLZi7AVkWcxZiOJ4HG5vO8lUDcHCF0EXEMs4i++wZe8KYSvw8hy4iGib249iVJ0NtaeTszRhGQdoUDs30MD+FUIYIDAf1cgoh8jTyPml4SJB+SzfY8PMWMtAcuxwhtjxBtigK4lKBOut7RNIh+dQ2zPJeAEQoUSEAEWW0dq7dyOYC3zz38XDIYEEAJFQGQ9JriDRPpuuby7t34N/2cM0C4M16AiqN7YPpE4ugQbXUxSZhIpFIdkbeqIHn1mrfvlGGKBkOQQM7YiiVsZyH5LVu3t1y4MgKzC/sUZoF2EZTvXr2UvROOrSeoc8kBMBBgEM0SINCBM/EW17rrxPFKtqH/jlVksSkhAGijJFkzYJZ/P/fBgtUEORuX1X9uOwJZuJWFPryI8GKbWwyXqiI9iR2wq4X7nS+7+MHDXRx0Di2JJEJIQiOUeJHO5fP717dUCetMY4D28yCqsXt9yDhLditFO8lWEN5R0g9+lGKa1w/wp0Jl10j8wCM/vgn19kAgYUXvqNUJRsgREshubuEhW9t83HgcpYyLeCU51TWYNifgLFICYGEPQ/MEmkj9qBhwzAwIDkTfZQCBWeGwbvLIPEmFlAB0DBUpE4LWhJF+Ulflrq/3USI+HoxIvwNplRq9/8E6S8cfIeedmCIbZarOpjEAxgrmTYOFsKMaOGcY/XLLOXZ44Fw7koD/vGDQ24kEIibHEqrToal2TniNX5j+lYFSd8MatAWW1h9MM6fXrSOvf0E8JITFGD141upf+KYfDrA7HgHrHFyukE/DUq/D0DkiFYHXkVQ8XgEMPrSQYlP+QlYXzdBkB65qbg2lCRxnVWdIbfkCaCvHlicuBzla9pQlDVJ2DyyQcUWIqN0vVpyp0pkc3zPJ81WuosCZBHyXSeq5el7ld1hHT1dxUGzKALgdpdXXmRtLxR+jXCvFltQuBKcBMhekKrTULGY70rHVSNqYBk6SCFkpxc/0sz50RmAbMxn2mpFYAQoIcJTLxBXpt5quyiki7Gpu7aRjqVhHpV7PnkrGfJUct8THQAsyxMNG6723ATAuTmsRwEefwunMVZtSbTPn77v7hzCvPbYGJwGwLHQoZhU51v1ukXgtDckSk7Zd0TctyWUWka4drgqlHeLKcWFe3Hkky/jcKGqOec+UFpASmW2fDsYD171hgorqFxHULV3VO7cU9kI8gYarsW933TAh7crCju4IHqkFRDHQAU7Qyn/pPA0xVp5VanYlhKKhFo9v1uo5DWY4to8ZhDFAQNiHa1WWg9F2MZolqIrwbvF1d2FJxkh0Cuv57WxMgExjoHYRHX3ZMSIWQNO4zk3CSX/+S044hpFj1vPFzqwzXkFggrDJDqaIvQkloG5r/LgpsqtVPGYbyrs1cRtrezIBGNWGyLIVp6iQRS52UBURhUGGnqay+OhIYXARIJ2D2BGhPu9u6B+DVbqcJ5fCnWmv3BpitkJRaxlSL8nVgr4dmtT4/okVC8sFFsnLg29WQWaqTG26eOpXBnudB24nrkpgyAyaps3Urw5FeAPQCr/nvZa2IrfMBqg7pGePTX3FEx17dI+s0wIgzg/L/5dcsIFvnbLXKKe8T2K/DGSBYAsBKN0w6kpU7u8vgzkn47YgIVq/rvZK0dpIjGgaSyuqWE+f8kIo6erQBFvrLZuHBjwKtaZjS5t4dWcgmIen9kfV1gkIEfYNOG/b1wv6cyxHCAEIDkUIOaNGK+ZWJNOqYktNmIdQQEZHVyRRe/5wIV/moEIl2YWQVVm+cOItCbjOq2aHMvB7PV3viyXX2KArdAvsFbOykOqMT5k+F6R3OzsuAR7VWsqbsT8Q7Vws9g7BtP7y8B3J5SIbu/+nq/EwstVFiL3BgRHCvPmnuoWXCEVy+ax/ebxrAUhr8JBltIUeEEDa0s/KE3UDJQLt16hYBvQIDAqUStGVh4VyYN8mNXrLO9qvt2qojdsjeqzymCHRmYOJcWDAdNu2Eza+59Hl3AHkfisUXSnqAgSbEVwQoWCJatJPB3gsE1ug1hOLqbPNSpHZtxuhcYmyZVyPib1tVxrL+YqkE86bA4kOhJenTXKmEQhHvAzzqUyqSV3WSj22tZI245GhnDzz2IvQMQCLh1J4qH2EYPXkSLCFCxEtMfsfRXPQ/USigmtl7GiFzyWN9QaP5YFrl8MoOyHhH9o63waJ5jhGDRe/RPfRNhk4Ldve5tDeXd05PxP3XkYGJrTAh6yUbeXNQKBVcDvGBE+C/t8COfZU8YiyEVxtBCUtKDqP3+XcJPOwcnbUfdnmTZ8DYBquCrwrTUjArgL17oLXdERXFTuIWl++/tBsODEAc1+L/8vdEAFM74PBpMHuixwQKqSTs7XeMC8pJVIN6A02u1WcSoQrF+EPAw6Jrj07y4kvPEOjhlDwDRhtI6hKTFnFQuOSzvEwWZsyCqVNhXw42vgx7epw3D0wF6DRIQYdygbmTYfEh7vuTr8D2fTAYOQZkfKZoRyC++fotSQyRPMNhZy8Uvb7jBOLBDT5S1sJPHSUXtz5YzqmP+zEECpnp8NzrkM+78pelAnFpsFipyg7zJehs8U6330WRDnFoL7Su4ryzCv/rOAuBQpFE8vgQLS4lQUCBuEzGmG0KHxJDrThCcJLOA5t3OYknExWw02js6t9lp5ZOOD9hgY4UTLWQ8tRacYnQRB/+xlvaVSxJkqhdYlA9vmn4GE36WaC9HAWqiImBPQIS1nrq0UxK6xIoEcgamGEh6eF3XJ5D3NypJrWI0VjgEOoig+pRvpAsNc5tLOXECVWJUDUcPuBRWbtCukGKLHXdgkYaUX5mqoe2cV16Xc4PJhxEI0AQ7z+OMqjM9j9k2CKbDVCuCWQZnvoWPQMy4hKnCdo4gmgTDy5VGtaOY6CV4c6yfE9LlRY00ippOLd4fzTXIDqhKeobiYudfhGi5WTaSaoP56Am+xid8QvUUZgqDSoV7VX/mzoGlX8H6goy2iRMj1xWmxgCLf5mqWFEfeFRqx5Mips479NgU3Vfnzh7DRUKUguapIl5NWJ2+ZlCM7WsWmSSRhlg4yhDlQYIbSFWzaiLqh84Uni1DsTgk6Oyeu6oi6cyBqnUS2injKKRdfOPxtRhvkjDcAhSjs+H1j6jdTak9eWcMZrWSHOM9PBo6x/BtENfNEoOk3LDgRt1QcRXegU0Hj8z/+IvGSGpk1KI0ocwaagn37DB4QmMC5U01iR8QbPofYF3dkEC3mo8GA6X1fu8/hCRfRid1LSzLgaKBY/IpkKqDQq9kNvrgE7rTJi5FKYfBy/+J2zf4JCf2rca0cOjjMq+EGE7hgU1LmLIYRkoFGDeybD0n6HYD1ERph4FiRa4+4MQhbDoYjjsvbDlwSbdkbcY8S4xFmK2GZTnhim+AhJAoQhHnAHnPQKb74X7/xHuuRjW3+Q0YWAvdG+DPX+CYg72bXLFiurWV/1qxLixxTTWtvKzErh303H8/40yS2nyvNSVx5RnQ8Q84aVWt7nBus/33wpbH4bH7nIFCwagdzs8sgpKRdcomXca9GyF3IBPpku+8lO14cEEEJegEFeyyGSqYipq3f9D+wjKnb4G40R5hzjB9RaCKpMzARTz+J6G34Rh6jdeiEOXwcaQhFlPQYqIJiuOUNxiWjqgYy7kdjkHl++HZAb2PAO7/uiKHhiYfCQ8czekJ8H8k6E0AK8+5j5N6KLEYB7SGVhwKmQmwP4X4NUnIPT/BxnITnZSiwZhxiJncq9ugFIOwqRb2kAeOqfBkSe7ubc+DAP7IZF0RObyMGOB80mFPvjzbxwtQVhmgmIwRAyQCNcb5r5/C8LzVX1f38pKwGAOXnsc5rwL/u5O6JwPA4OgEYQpiCJonwOpduh4G5yxBk79Mqz4FXz8lxD6fH4wDwvOhHN/C3NOgda5sOyn8KE7fX8hDad9BT71LPztD+GUa+CUq+Effg3nPwpts111KF+Ad34a/v5n0H4EHPpe+OQTMOVoV3iNIjj7FjjzNkjNhiWXOfNNtPp+pFdtF8Ce5ooDW40sXxeD/JevA9thOe+9n4Dtf4BjV8BlL8BZ34DkRMdVC0w8zPHtj/8OD1wIty6GR2+A2SfBpMOgvwjz3w3n/Az+8DX4+Zfgl1+Dhy6B41bAMcugpxeeWweJLDz5Hbjvk3DbErhnBUw7Fk76DByI4MQL4L03wF1nwoPXw7qLoG0mLL0ceiL4wLfgsPfD7e+Bh26Ce1fArCVwxJlQKHmf4LudxvxCEN8Y0fAe4tJnQCueSa1zaPs3w/dOhSM/DO++GpZe6oj7/ukw2APTFjpmvfKIK4TECoP7vTrudiWsD3wHdj8Ff1wHE1qdje5/3vUPZi2F6C6YfJSbd/ujzj+EAbxwv1vHhEMgG8L7vg7dL8P8s+DYdpCEMzFbglnT4YQLYdNPYMlFkExCpy+pJbLVESGgKGCS98IgRkEoLvoDBdns937YodJUKe9sKzDw1I/gm4vhxYdg1mKYeYJzVDNPdDY4sB8Cb4ezTnIR4vWdMP1wpyVbfl4pZsYxZKe4Ofpfc5o0fSHYCPp2QBA4wJXudAvf8yzMXOAiz9ZfO6KjIhR6nJR/dyMc8xHHrNc2grHOTPdtgp9+zOGTZAgaxySBEk/yLwee1C5M6DZDPBLpmuztJOwNlIjBGEp5OP58ePkX0L8L2ifC692w6cdOzfpfcxFg2nGwd5MrY2cSzitPO9ZdK4jzERpD7yve2YWuijzrJOedX3rIZXPTjoMDW52jTbVAX69zhGJg01qYcLgb57kfw1OPuBS4XMLNA6cucMx6/DZ4vbeSgoNrxwe+kBoixME3RUS1i8Bwja/W2eAO8tKNkYA4UlJtsPhSx+WBCHq63WRLLoVtv4Udz0PKQOc8p/4RDioHxkWOrb9x2tCzzdnehPkwEEPvAdcSP60LnvoBbP8TtCWcI9v2W+iJHfGptAvBW34OW5+GfLcb5/gLXBGkXCFKphyB+zc7Zi28oNzrciqfTpXhuSXEMCg7aWu5y28DikMRVLsI5aq+/bo6cwstdLG/EDH3+JAZC+GUL8OODc7TH3k29L0GP1nhYPGJFzi1b50JrR0gMZz4KaeiHW+DyVNhz4vw++th6WWwfwv07oalF8PmB+D+CyAUaJ3hQmD7bFj8EWifAsee4xhy3/nQloZtj8KTd8Dxn4DZJ7vwWOx1n0/eAX/6Phy1DN53Exz7cdj9jAufm++Dl34FiYQlZUOK4Q3y6b392kUoQiQ1O8IyE9rQgedAp2NalWnvMMxcDGHG4f9dT8Cff+c43DkHph8P+R5ItsDOjS7UzDnZ3ZtsdQixdxfEERzybph3isMGOx6Dl38PmZSD2oe9x4XODbdC3x6weXjl97B1vdMWY/weowgO+Ss3B8ZhkR2POkbY2Alj/hnOn5Ry8OpGF8bjomuJxfyZ9NRj6N1RYJWrXjTYIJFdQTq+k1wUUYrDmk2nIZDyxhUXHRorV4MSvudftBX8nfDZIT6nKKOzAKfiYmCgAO+6BM64GW6cBnv2MLRDPJny4KWq8FEoMrSmwCPBMiRW69rscdV6kyGIiUgTEgUflC8M3l+9QWJoD4AsJ3Z/DHxfV6c/RjY8g8FETFqCmtA4BDmTkKnC8+r3raWTtdfKHbdUGtLVm6Rjx4x87KJKoddJvyPloasdnlGq1o2jbpyh2oWBTLqC6t38ERlC8sFauaqW+OG7xJ5FVRGC7IWU6CaIBRtZbORClNZtzdC48h6qBjW4Vr5eP45VeOcKmOXNZuF5vvMcNU+na8aJh5d+bM08lpCQguwkGVyiXRierc0NpemO8GvbziZZvI+CRijD07LRWmjSpEhZU2wVhxEKfmtcqg26t3ji3/hhFgRLQgyl8K/li7nf6DICWVe7nV5GOhOgq7NfIht/lZzfKDniGYBx1Pyq742Ktb/D5JtVCSjRQoLB4FK5avDWZtvoZbSDEXpt+ptk9SL6tQRV+4TH35Zu0gaT8RU4x1b8KNEqCfJmjVw5uHKkMwQyQiFVWIuR5RLrdcnvkeFcz4Sw6XNja08f/P1jqyXHbkucfENW5i/XLkJWDe0oGuNe4TJqX4bVLjWysnAeBbmNFhK+fWIbskDHuSddx7LTfMwFX4ugtBBSMGtkZf5yXUYwEvGjnhcQQf1WHiNfyP+Trs6+QjK+jkjLx2TCUWvxMg4HeTDyLm+EDAkRUfLmMlk5eMtYT43IGOfx5kCs12bPIoi/TagzGCBGkJpDUs1GbdamGs89w5nmjsy0EFCS7djwfFmZ+9V4zg2ZMfoWleXELmcYeBBtWYI195CVgBDjN8rpmA5RjGYCoxEtQ0cjIkIMWQmIgh8x0L5kvMQf3LG56sOSN7R8FKKvEOrhFIBSlUY06smN9TCUjCLxBAEpgRIvYMOr5crc2oM9NmfGHWmWE6vidphekbubTPsJlMwVCNtokYAkxp/9jIYWPFIbvL6XL8NYZxEiFCWJoUUCYBuRfB7pPEGuzK3VLowqcjAnSN+8o7NrJnSQyH+UyJ4PLCGpzjBKVZIrb8JQrycMO+8zwtFZAWEDYu4gmbnr//XobDMHOXRO4Ya2xWjpLGJ7OpZjSNA2tKHZNtkhIlVHL8sFjUhyGJ4hML+AxANyRd/Gt9Th6TEdn7+p/VCieBE2XoTq24FDUJ0CtKKk/W1FoB9lL0a2YuQ5MI8TBhvlc30v1jStugjfzOPz/wtnbTfA3bv4pAAAAABJRU5ErkJggg==">
<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAABUgUlEQVR42u29d5glV3Xu/Vu7qk7oND2he6ImSKNRGGVACElEBYINAoQxcAkm+X4GfI0M9rXBxhd/GHydjW2wscxDMGCCsBEYhIQQCAQCISTQaJQmaEaTc+c+p6r2/v6oXbnqdEso8uk88+hpdZ9Tp8Lae631rne9S4wx/HK8jMZoAOUW/9QZZ2w3UzsZ383kNsYPM7GVzjjhLMf20ZlFwIAyKAjAAUfh9dFeingMLaFvLf1LGF7HglUMrmFoJV5f4evRIQgiiPrluKPyBDcOg9EYUzSI8Z0cvY8DP2PfZsbuYWI3E4cJJ/ANgIAmNgiFo+z/GFCQ3A+tCTSC/Uj0/oaiOUh7hIF1LN3AyGksOp0lG+gbKRqKKCT62JPG8ejbBCBO+rvD97HnFh64kT23cuRegnFmwAEFCsQFByUYia4bDRgEjEmfoMk8TR1tA9F9kvjPGh0Shql5OdA/wsgprDyXlRey4lwGl6dnpYN4L5EnjePRtYnuBHt+xPbr2PFtDmxmZtque89FXCTaBwzRNRqTf/jxjyb+uXAn4k+XHmtkXtHGYDCasEto7MeHFrHsbNZexOqLWH42jpexEvXE8jhPEOMwBqNRiU1M8cB3ue+/2PYtjmwnBAHHjZ+EsXYQPVpVeuqm9KxNxjiSH7LGYTKepWwqJtpjBEB3CDQaPIeRU1h3CSdexurzUV4cGBnUE2Mjedwbh9Fg7FZhDLtvYvMX2fI1jm7DBxecFihEYwzG5P0CqLw1KNCVT7dkHJL3MiYfeWR/XzC+yIkoQYd0OwTgwfKNrH8Zp76S0dOfQBvJ49g4TBT8K4CJvWz+Ips+w94f29utWohCh8W1XFj9Zcchpc2jbBamfpMo/L7yg/ZPghJEYUK6HTT0N1jzXE59PSe9hMYAgA4fz9nN49I4TAjK7tL7budnH+OuqzhyABfcJo5CG7tPUFrilFa8VFlMpZWU4ooKB0TexeSsIfOe5H+jNzgKEcIA3wcYOZEzX8dpr2fBmuIyeNI45mUW22/gp//A1q8z2aGhcJpg0Lr4VKQ6cq32F5R2BakyJjLPPjEFMrGILr1TauKbnOEKIhghmMHAwEJOeTVPfRujGx+fJvK4MQ6bhiiA+67h5r/l/mvR4HngYWL3IT3jSoUNTql0DfntJfvUKZkLJU8xTz9VZ23Z6FgUSuF38EP6+jn1VZz7v1h2Ruxo4uXxpHHkMpGd3+GH/5d7ryGAZhNRENbkk3NtD1Rt8pS2B6pyGamPWqiPW8tf2tvfITiKIKDj09fmrNdy7rtZvMHuIlkI5/+nxpHchf13cNMHuOuLhAavCcpmfZIBNJMfKC3uuiyjLkot7ys9AhEpOZFCNkQ9RlKwlezHjbFBq1I2HFmwgNN/k2e8i/6lNiF/TL3MY2cciR+ZOcLNf8GP/4HpaZpNlCIM0xsqmciubjOYZ4BZZxlSesymPpqRKncjpchUavYMU3MCEbJnfGYDRldz/ns5+y0203ns0NXHyDh0YKshd36OG/6IQ9vwPBwXHdau+0o7MBkkQ1Ulmb0uvR4bpT7aoMoOygcxgpiKa6k7gv2NoBzCGQLD8c/keX/OyvMfQy/zqBtHhF2K4tg2vvV73P1lALfPhpymfsHVuX+puu86f/dVja30WOtm3kYz5596eLoyiKJBKUTwZ3A9znsnF/wxjUF0+Ojjqo+ucejQBp63X8m338PEQVptQpPClr1jOpN36rrk3anfCaj3BSIxuhoVZrNYuLY/lB1BXZjcwzioN76yAYmDCel2WX4al/4d6y6yvvhRjEIeNeMw6BDlMrGX63+Hn30Rx8FpYoJq31GXmOgSUlkZV5qeayz7p1ATapTC82h5CAQh0z5hgKtQqsLgpH7pU4+xSv4qpCbPkjx6Ji7+NEpxwe/zrPfjNFKP/EtiHEZb/Oe+r3PNb3F4J602obYVc3pmoZUPXvXEFSqDR5N/HgLdEBEW9jM6xOggC9q4CgMiTHU5OMnOQxyZQATXQZvi3lP+LikFs2aukHbO4rCAUmjDTIf15/Mr/8qSUx81F/PIG0cUTBn47vv43gcQcFrosDrVLJe1pD4Xpc4HxcydygXtQGgIDcuGOXGU0QEcwRiCEDHWiB2F6xLAnmNs3s2RCVy32h1EsJuqAc3mtIAeYU3OxYA4dGboX8gLP8xpr310Et1H2DiiPXDqAFe/ibv/m2YTkRQCT8qYmDT7cDK+gxr40pS237o7XsgeldAN6Wtw+iqOW4hjCDTaWJOSzBcYg4r2DOHuA2x6wH7c1By/B6JaV+hhLvgul44ZlEvYRYec904u/kuU+0hnMY+kcUSWse82rnoVB++lmUlJpAYM6IGBFn4QyW311KAguS8Suj4rFvHUNTQdwgBHIQ5GY7D1vNQyovKexhhaLfZMcNO9SAgqg2Jl0BHy8QQ9Y+S66KRcr0mgNgWBsYlMZ5b1l/LyT9M3+oiGII+QccTh571Xc/XrmBqn0Yf200dXACrKd2c+KDU12axUYZdK8ANWLuG8teiAUNNw0y/V2hZOEYvOGUGHOA5GE4QMttk1yXfvwpVe0AuZYLO3cffAarMYK6VoCRCXzjSjJ/LyL7H0jEfOPh4J44jd4U/+nut+l0BwG5gApBo+qoQ755MTVu7wlRCqI3QDli3kWevxu7ayFWWwogg1KoKtyEWV2lhfYwx+SF+Lew/xk220XAo3zQjGxEW1mufdu8pTucGYElkpeTkO3RnaC3npZzjxhY+QfahHoIpmEMWNf8LV70S7uJ7l7PconhUCUinVwKT+JkqNZZD5lNY0GpyzFkmCOIkfqraGIplINsoFkjxWGzyHbpf1I6xcRBCgJA+0m+JGVcZqdR6PkfrbLxkCADVYvg5ptOmM84WXceenUTG4/Pg1DqPt4vv6W/j2n9JqgRDq3G0yVTiE1IMcJnNPC3gAJfir8GySCNcPWb+UBR6zvr33FquOzceYFAqLPqxic4mSl4ivJSGnrkRUxEKvBnOLblHiQ81l3FJVFjZVoYz9F+J4oLnq9dz81ygHHcyjavCYGEe0BI3h6jfwo3+j0Qc6t6Qk/20m/wjrCvFCNTe4RyRbSAG0wXNZs5ggwFXVK1XHZK3ocYYGbdB5GEYp/JCRPkaG8IPiudWZLyaNwVNrkGqEpoD1ZY1G8vurxKGSOHhNrnk3N30w3j/M48w4opUXar78Om79NK0+C33q+DpN6doKPK5CjJaCV6YWRDf0gi+Tr/A1iwcZahBqHAdHENA6hcyjvqbou5RCsDUzpZAkhREbgoQBKxeV2p9KhmKq+ILp6ZniB00NR7WMAxXjFQ3QavOt93LjB1AuWj9c9qEetlqaNlz9On7+Wfr60EEaT2WvR5eWvsmchVTeI5kbCDdVmHryhtCweADHxNmv2OJnBGMoZR1fqFMkI6LhSOwoleAoFCC4isUDeMqedh0ELplVUReNUgX61RHSJP/XnPc0hBqnzXf/mJv+X5TzcMUf6mHITdCI4utv5bbP0eojDGoLGaZmKei5uBr0XFJ1MCtxYDHQIoh6G4UwjH2Hxg/QxkaXEruSJAgNdHqcBCjTmn6PVoPQFBNXyUSdtbmYzFHprQT+KQGmRadsUBqvxXXv4/uRfwkeB8ahQ8Th2/+bWz5OXz8mrH54UlN7LC50M3dRnhLpV2p2EQ3G4AiushRwreM2uLjD0VLD4/ww2fOVoCQOVEFrG1dpQ9Oh5VnorK6kV/CbSU9lNgeu3DuLbLEC1VmKx8/uH8bgtrj+vdz+0YfFPtTDgIH+4M/59l/Q6MP4xXYBasLy5E8q/nMIAQRCUHOvTVUWI3mwqAxdR482apE1cSFeOak1GAgNCCZOrKIMVmtL4LMZh4rNhRSZFalGuqQO/DUVG6TKnHwIGqKcQ8phbGy45d/bb9Qog9vk6rdx53/84vbh/qKWsfk/uO4PabeQMPUOpp6TofORvBaM4Alt8ARl6IIP3ejx1DM9i5ut2LtZNEcDhm5gU8rcAxMw6fagxHoK4gxWx7gWJkXroy8IdJpxmKrdXqriTZNpayDPNHYFZWgJrtA1dIXA4GucfLHJlBC2XMQjtiREg6+8gf7lrH12yqF59IzDhCiX3T/g6jchDQsjzlkoMZmENgQUg4rBkJZGTNrtboSuYkIxFgHbJYKxKaPppgZ8FAzM+Ki4bUEpjCE0KEHH1J6oFmj9DoiKuc0q92SMwVFM+8x07Z4kNaxSU1NDiX5KrkULTcWgZlDjaBxBNCGIIlBMKsaEjk7311o4NeOwtMFR+D5f/nXe+H0Wrn/IFCH1UCENh/HdXPVK/A6uitnCeY9b6YAT8+9XrIJlPu0ArQmjK1T4AtAMGfFZY+h3cuuvwpFXxTeFpPfYTFpOy+bGStCaMIxNBNtWFGqbggWBPVTCeVYwE9AJUDFLtBKAkVIMkWyWEqMvrmJUWBWwKMTTGCEEX9AKDU7I4oDjNAtj2YjKNJ48RGsPrnEbTO7nS79GZyKXPD+yxmHvWpf/+h8c2Y3bxITVUFUl3TeqYixSrAhpB3b/SDw64MZtYVpoBKwMGXQIMzoZUp+wVPSbGBzF0UlmteW1m7hGH/VURpWXMEpMNJLYQVJ/KcWc+8cJdZpjF2qzUgXUSv7cQmi5rNIs8nEMWgjF+tDoVkQH8gVCRgOW5VP6JNKSqpUQrT0d0uxj9+187c1IvHofeeMIEYfr381936XdTusm9CwgpUYtjBoWdvE1gWRurrE7RBZcChRByLKAYbGcGmOKm7ZU+eDsg3GEyVkOTeCpDEHG2IchGX6Q3V0cRFAmF9VacAy6ht1H8ZS1MFP1YMrJVDbeCqBfWOGjQgKxBT+VDWxN5uNCAIMBoxBmbk3iqnR9jVoHtNvc8UV++KEYXH9EjSMqxN/5H9z0D/S17CKTuZjWafFJWALDAaGyFYcEfDTKhmZabMNgtEk4CmNYEtDK+Bc1V+pYXKyGrYcIDFqnpGIdm0W0F0ZMUqVs9JOAsxL/4Id4LrvHODIZI6olbErqm1+SaHRIsVynrDMjKXUhyr2z9zSKlAPFsGZRbElZO1Dl8F/SCw81jSbX/xHbr7fkoEfKOKKmxcNb+fo7aHq5SoGUkpECbTMKBxcIwwEdSRneRjJ7o6RFr+yi1IJjGMlg1Kb0DKgK4JNV5TrsO8KBaQaaafUhSUQjBo0bo7kJGuE4NkaJyi6ugy9s3oMjKTxaGWNVVhCjU2o6jIa2OSNZANEl22BZ4pOPYhpjc5kAFoW0VC7ZMfmSr8QJWnYTirL0r76ZqQO2j/ARMA5jKTzfeCuTh3Fcuwp11VZf2DBULLW2OCQAJwYPrB9VGJVK5GTBzbTrRGiGDCjCKtZPb+Id8WF/uoPZGFA3Jr1NyWKNrsgYi3+k0Ykm8Gm2uH0XE5OWb1zJTjI1RebkzUvACWPQJYOoanJ7lf2vSi042v+GjU3ay73aUlPONBqvwcEdfP1tRRTuYTOOCAm9+S/YcoMNNZJEkTJWU0LxtLAQvNjl5/YVg5I0Aoh+cMQeXMXEC8cwpHO7VA9MBXJ7AwbXYXySH27Da+GJRc0lLhlG6YMCYvtQYquy2hCE9PexeT/37qLhxQWaeXdNJsh6S9H2U5ea1J6SsDdJmpw8vcHuZ8IAtDPbrYkkYmoIQclvwpC+Nj+/iluvfFCVFzVvh+Ky9za+9X4aTbvCiNGh3k1E0Z9coaUJDGJSm4jqnCr+ORvQBRpl4gpq9EtFS9OQItSm6q0kWyvXhobHzoP8cBtOA1cIQnsCNm3RMSMpYXgoa0P9Le4+yG3baLkZKKy0OUmVs5NMC1Z/dLYqA3hnQgct9jx1ubASlzYlZAAbliU8I5PHaitDsejyv/X7HNuKmq9zUfN1KKHPN96O7qQhUBZ9kp6+NloKrraWLpnAKls10CZT0M+i3ZLSQps14HoWz5aqDuzIHNse2/fx7buZNrQbOBCGBAF+kBZQdILZhDRdlMePdvLj+/CEOqEfQ7EZorDJR2hbM0MmikIZEyOklnZvLJc4sXuJSfMiOIKBpk7DHclk7FKDOtodWuO5zB7l+nfWtwQ+BOOIGCU/+gd2/JBm2wpm1BXiK32hMbhJBBenrIWdWeK9NIrhVbyGwkwx0xicuVBY03NfMYamx75jXLuJn+1lIqDl0e/RdHAVDcdW6TyHhofxuH+Mb97BPbtouLbwYWIuOFVtmFT9XsV7Q9Qyk7RyJa4t+k2EtZQp9VEopmMn4mAh/zrOBzXsuDCk1eaOr/GzTyHzci5zEYwjftex+/nYU+hM2f6f3oxq8sWFKE8ZVCwLCBPCRLzKVT7YVknDQbZDNbInA5qjLkfAMbUk3jr6bi6BEozG1zRdRhewfJiBFk3HLtCuZmKGw1PsHWNiCldluhbmki6VqtpKtCsYYZXB03GEISmml16ySfF1Ewt4SBxEJ2tmp0OgK/LkcskmOVQS4QYBC0Z56+20F6dSSg+1tmJA8a3fY/oozb4ckFKoA+kMbFcmVIbYOC4XqRmbR6RFE5NfFvHhIs/qSgX22kM5I3vXsnlTFCo1XLRh12F2HUKcGJk1hMbC566i6dolXvBTJo+1mJ5gTxo2iY0tImguYRAmn0mKf1miU7JsyITPJhO0Sj6y0TXCqSbOXI7s4cb38YKPzgl7qLkzlC3f5K6raDTRQQ1zR6rzhWwpMojfFt0XR/Ilq+g3mYK4JfDFDI+IuicxSig1PGRK5fuyHEOh2a7p0vBoqHR794SmS8uzKWtll2xdu3b527PvD7LmYqy5ZN1fxBlI2iaSIMwaU1QQznflSA1/SqjoCRXQAY0mt36cvbfYRv6HZBwxZfLG91qfKaX6qsTMA6FXzgKEBj9OFLWxpI0Ew8BYIhbZEnwW2xELPPvGAtuV/l6o1YSUhAgeHznUBCHdkG5A16cb4od0QzohfkAQplt3VpTB1KRjtfSczAPrJigfdnmobOiacSIJNmojTbGW5CpCsart5aZiXeXmpBy5K/wuN7y3PhGf061ojXLY9Al23kqrjQ6L0bipbOmsccYaOoqmyf3JEauAY8ihW1nqlMRN+hGK3K0iUJma9kmVuXijCUP7DMTBdWi49Lk4ioaD51hfpg2BsZzCTkAQEmp83wJlKtrhVBpRSs23S/4uRDHTtLBIYtTSxGhyprqrSFGWbEJHjH0Zw4xK+WnlzjldypWkBChLSKPFluvY8jXW/2oPwofba9voTHDTB3Ad6wilsg0pAYuoaAPMBpVTikFtQ/ToLugYLKdc+47pHSZOVRzDmBBqm9GpKjjBZGKxKP4PQ9uS1NdksM1wP0P9DDXp82i4NFRM6TDp93a1Rc2j2sRswKzPsWmOTjI+w/gM3a49K1eBskFiRWxuirFXB3wHL0CrGB02sXR6vG1EphPltGE2rTPWniajrVpyvDLdU6C9zKSMNuzv/SnHv6BHTOr2KrDd/q/s3067TRBUC9wY0ni4jv+YnM2Uoatoh6DiRaPQhtBYhypJGV3STdXGpxpfGM9HsmSER3XG+2hNGIDQbjI6yMgChiODaNjqPEIQYDSBwUT+ztgcO/q6qHYvgie0mtBkxRDGEAozXcamOTDBoQmOTTLbRcB10mJvZU+vrS5pxhxGxDJbw5jbnL1XCQUp8dcJNbBhGHPoxKGYqVemqxCBKWjgaBpNdtzCXV9i46vquimrUtloyc6O869nMr4LFbeGFvVopFp9RZc2/MjMQ+hTrAzQccxFgltLXmUl3nglwWfhgMcxbZPYanTS4Idow0AfyxawZjGLB2k7SJSAhPbSNCkqn3B/jMmgcEnpK5M6JbGhcvBcm1ZM++w7xgNH2H+M2S6OwnPsBwtBj44jROWwwtAOCSUWR49TNmPSnTjaHYn78FQckexQ+LqoXWNqlIOy7MnyRACl6HQ47ize+CPETbeoOYwjsqOb/47/voL+tr2tPbL5csxRSbRXEAqLhYVdtFhhCSlQ+jLbafRgQo1rGPfYnwlFs4yyyCt1AhyHZQtYN8qKYfo8jLGdB1miuTGpvSYQfmQiWscVtVgZzFF2AURk4zQVN2na5bkgTHXZeYTtBzg8DtG0l6SbobTDtxXHaYIQceL6c+wmbCqbrfUkUYjmgMe4rqikmBqRVnqKrkb2MTPLKz/PxldWbh5l44i4CzNceQaHtqMaoHupBPdQsanYQiAUlisGfVtKSG4E2QKSyYRmhmMuBwXRFRcsWLNYN8qG5SwZQDTdwEJGCQEgolXakpBYECz56ugxRMO8jE4Bm2jmgY4TDyMoZeccQEaFxuA6NDy6hj1j3LOH/UcxOjWRbOYZZfVDiqUhxmBUGnrrzIgxEkZjLCNzUDFOSkEy9cofpoqeXqlnEW0ea87lN26qlF0vGUdkQXf8O//5Orx2DmTtISbRW+5T5+sFoWIJLNZojRZCrOhFssqNRgyOEAhHXY6ZnGUkeakfgLBmlNNWMTpAGDAbYDRGbGaRBdMsgSgzr8niKJEEg6RuxZbctIU1c79PQoG8P8IQGoym3QLFvjE272LXYRyHhkobohJHGcCww2iI0pZmLJKb/aPjgAND4HBImDQ4JkeXqdPjpoo4WMmXs7t1h9dcy7pLymlLyTiie/fJC9lxM43W3MbRq3Ug/pvON+0AoTDosCTACe3NjUrVSYXWCDMeR4RuWGKGCkbTDVk6zBnrWDaACe36NvnzMAmhPO50zYKM0dInqWrGPbSRofghnmN9drQPJdFuIvCi4shJxw8tqjZ4Dsrh/iPcvoPxCVw3jnPzC6alWGxohXFlVWWAVwMGXzHuMA5BWAxd9TzGekiVoy/YUCQ1dtplvOK/yiT1vHFE/NDt3+HTF+F6RYjN1ABcuoR86EphzTyK54MS+oQBg2Nw46QuUEwbZoVZgzKlnVDoBnguG1dz6nJcmPEtVyrhAKQdtiajsIANhIldWGQBSqyuoeuk1P7oCK5jY5FkjqTJ3GkV59WBieHt2FtFjqDVYCZg02427yIMabo5+0hS7oawEBohrsKJiASKrjBlmI63EKrYIVLv0xPtCWI9O0P9oAiD4/DmWxk5tSAyVpXK3vlv1oiibaOHPpqhVkCtLr9NPugChmnDdAQrxY0kUUgoBqdcmhc6XUaGOW8Dw038gNDYWCE6VRVXd3QsrB55mTSGIEP60nHJJkbAkqagaKfRBnSqD5ab/heHCJHHcRxLp40iyuhoUx2U8NQ1rF7CLVvZd4Sml3KxJK4JdA37BOXYG2IcdFRmi+fcmqoIoyy8L6XmDF1OXqqMyfGYmeb2j3PJXxVK/5mdI9pvJ/bwr6fRGQc3Tckqu8VNxlnoSqKD2AmdqmcbgY5tvK51zG77mm7Iycdx5nG44Ic4Kl2p2ZJEdodPkqCkQU2Stsd4U9EmB2jaGqzYJWW0dSWSV7OMEs4EJHVi3EzrDNZuwOC6iMsdD/Cz+3El7pjKr5hK/V1TL8VPzRzC8lAzqRHHSrcTQfssXsVbNtEYzO72Kj8lCe75T8aOQqPY8lvXOESMfFfovZtioaFMhEm4MLpUp1CZDUOHaOG8U3jG8WifILREVFRGhFpSippE0X5MuzIxiyJln2MDDiW2HutI2jMi8eBBrWPCGJapm9S0bJgS7zGhtnGPo3KxsHLoBnRnOfs4Lj6DhkfHT0MQU6+UVxCwMHOpMRtyjQuVGQolFo7lUDY4sJMt11j8s6LwphyM4a7P2y6SSiEUqeF6SVWDV2/FtHLnMXk5hoRWGYQ0GlxyBicvYWqaRiOl40bLOvIm0YNXmaGvCSZhXYkhNNawGi7tJp6HozDKlvQ0dME4KJeGR6tBw6XVsH4nDGMGcmL6McTpxJBuFNCFMaMs+lTUkD05w/IBnn8OSxdZ+6jTOjM1t0LmIaudbd1QpZVZp3sQZWGbPldgeMRuJQoyDmzi355CaOztNvXAFz01/0wV5WfO7EsopmpKCAIG+njmKQw36Aa2QT5NQOLOgyC0XiDJG1WcHtvHIyhF06UTMOEzPs3hKcammOniBymJNQQXlEPTpe0x1M/CPhYMMOjiuIQhOkzxmzT+zaYzJuWtWb5BzEUNNJ6D4/H9+9iym7bXCyuqu5+6ZsxUQbf5Qc0MEcEENPr5n3cyuCpJW9wM40txz1fodGlWwRtlu57PWJO67oFK8XKdp9854Pv093HRRpqKmS4NLy58xOWJbEnCxD0HjoMOCeJWWEdoNgg0R2fYc5TdRxmbouPb5hGHNEuMrtAHA+MRVHoAUXgug32MDrFymMVDtB183xKCJF6quWmVJtMzEsMV1vg04QzP3sBgkzt3xjB5/WSxSsSzuqF8rkZ26kX4MdBgYpzt13DGWxLjSAJSgzF84hns/DGNls3fej/73iy9uglWpnfxNivXpBke4nkb6VN0Q/ukiUTKlUXNk7RTZYoRaTAotFxmArYdZvt+jk3SDfAUrpMWxKVUeU9TkkwE6GtrlAv6WLuUtaMsbNLxCUJcJ9NHJDHikrm2RHZMCcoh0Ex3EI9btvDAARpurre7aB+Zgr7JLy3piWGYudRNipqcDp0ZNr6IX/vvvHFE/3PwTv7tqYRhKh8z5yiauiyXPNW0gNX0CEcKX7RxAf0eYYjXoNFmoI9mnxU2Df2MsorE/W0mtiHoazLhs+UAW/YyPo2rcFVeZqOGAmLq9JDFbrF+SKPBmhFOXsFwizCMA+S4omtI/XJEaUYx7bNnjEPjjE0xMUvXr6ifmZq4rU6vN9uklK2uVRBd83zSCpKUEAb0DfLWOxlcEZmEm/qUbdcyPUu7L52BUtcSbao8XKVJ6p4ikD3UI0NhBUwfZsJYOowB5dDqY3ghS0bp68Pv2lsTJLpeQqBxBa/BPYf5+XbGp/BcWl6atap61ng56Mk9uejmKpoKrblnN9v3c8JyTl9FyyMIUjggOpnQ4CpUg/3j3LufA0eZnI1lBFRKtO4Rz5meMnPEKY/q+X5DrlhYK61mcBpMHmPX9znllRnjiALU7dfh1ruuihmtNaWdBNSrFqgoHUqV8D4dF+d8FzeGsCIqRmeGfZMc2MvocpavxPPodizwHOWfrQZjXX5yNw8cwHNoN1KphUrxnTK3r7xpJ6oHOpOftzyM4Z6dPHCIs9Zx4giBT2Asj1cp+hrsnmTTfew/QqjxHBuBJjlnJcDVI94v7h+mNuo09X14dVqMUWoTwrZvcsorI+/h2m1j+jD7f4I4iC4ydXsIuUu+EoapCDbLQJ6u2l2ydedhYWGILxZl0pn2cyWIgzbs3cXhAxx3PIuX4HdsktLfZsthbrmPbpd+z+auPbJrXZLwqhvgmIVeEnIG0GrQ7fL9u9h7hHPWMeAy3aXl0THcdD9b99jyrOOkJNn0qiXDhUuoPdRSD01Nl6ypGXNcyAF7xAb2izSusPP7hJ1o/ndsHHt/wvhB3FY8M2B+KUl5LzGZGErXNDHQY/eLylEh3bwKjzUpjYlvqOsRBmy7i6mVrFqLaJTHj+9n8w48h6abM4vKErbpCTFJTQ8OeZQvBBFaLvfv48AY55/E6mEeGOOme5mYpOWBm27pSVLmCC3BExoGz1imywGKUkFS4iqXtzTTc6ydmet/C/MelMex7Ry8i2VnYXScyu68CT/TGCI91VVN1W6W7W+rvL+6bm+MCX+RcMqIsWI3uhwnStpzFomfKoddD2ACVm3gxnvYsY/+RixOnWkn1MwtX1m5TWa9nqrvj9UGz2O2w7c3sXYpOw6gw5xHsw18QkNoC0OGtk4z3tDgCTgckJyIoNRHoKa+LZmes8ZMj+4Dg+MwPcPuH7DsLIxRNuDY8wMccrQ/UyP+Sk+FpzIRvpIqlipvZuIyLSwSWmHMA6qC+ZzM846G5bSbHDrINbfxwAH6GqngTqGXrkefoKnhTpu816Oe0kws3KBg626UwcuwsqOzdRUjipWapQF98UiXUGxHTyAMBvRLOhRMqpQRswuv0MtEPYRdWfooGFD2Mnf/IHo0LqKYPcahO9MyUl3bVvm+qCpBRapqBOVnkPX30eW1FcMhoYDgRohWrACZUDvJjzWJFHn2eYzN0HTynS81QZKpd3OqfqlJfZdlTgMfPC8FYEzcPj+oWBLiaNv64KoM0CmxMIliVFuRyXLeVK46mXrBHGommlFPMbR3RuPC3lsjzpcCOLKFyQMoLw2ApVQh06WymWQai6UmF090iXR9aTe5R6PGQhQuhAm5PJtomBx9N/rhsMtYSENqPbFUqcrnSkJSO/yg3Lgm9WIYSSaS1VBAsVRYEaA1AdYVJuauYuNQkWayZiTul5SayRuqqpOKqrECzGPcafnCHZcjOzlyf2yE+26jo2Nx556DF8uNXKaKSFLZG1cZBBGryA1BQ2MUCGEyhiG+g4n6eHS7I8aDB1MORw1ejeR+YWCDqUv0TXU5ipqRLkKtViJ5+SVPsdwwFOALrqQ+MatrlQgPRa0PLc2A1D77anCzd1lOan2NkVLgYhAPf5pjm2PjGLsnx0wvP3JFreQ2PaevmZq+GjIiPoHBERZl0k6d+aTKINOGtP7ugK84SNqPJHPVHuvqw6anTlClEH3lSJDCf5XDSmhrfFXs2pKMYFdWfzi6z4tMGooVOgYqxeN1FcsrNzurSmtJkRvKmaq3CQHsvys2jgN3pyWGSoBcl6hf1QImVaYgVLA6dHxYDSgWGZRGKds57sQaoE5GxycJlu1CVxyImzikynYrc7a6ubVZ3h71KtXlA1YOIQ/BUazUeAEB6cxAkVRMIAotQ5MnWQoIjZBBSftDMb0KmaZnYbyHRJauEg9O3nP4DkARdhjbltpR9TCD/L+yyqLUL7uyjEnhGgaEQY1WmSpGzDcOy9iUwVE4cEyY1KkuONmelKr7IvVV4nJQKQmxqkblXuqVkyOh2WWGhkbHAbWR3DYehZ9Kchy5dC6CsMjYkS49qp6SJwQp5gVQGSr0XrOglNa4cHQr2ijG9zO5P+Xa01Mf2NSAa2W3p3vCSumVKBaZHM9PJO2yzE7YSFJfrfEVh/OQkZaUIdxjP6s0CFMTatSpPJSZbNmbHgqLoS9ExxN9yGRbkiHvhiatJ2eR+xBczVB+cdfNRadqQo+pN5RsilBt3waEsd10jiomd9CZsDSwOgEn3VPxkyqleqmnyZNpj+4XWjp3VaHJFCAkRZeT4WWO4aiyMxWSbXyhsNbg5eXkpKYOLD3bSnMTTGom65SnZySMyT5hOMQXEHstSZtx4ilMnJ9nYy8bXRk7ZG5I46oKyTVTz/YonJWqx5wqdR9TeTGHzhGm9ygmd+L7iFP0QHWSIHVjOwuC3PQce2ZjCMXiCBJQmZ6AOK/T8ZqLgqFIicsxdBzGMzrwIQwrFvsYnxHSFn6p0ZXrcWfr5mT3TomzSbsIi01enzovZEKmjCKZFCwR4Uiy66ZhIE7pe9MbyohF3S4i9czC7DNyHIIZju5UHHmgF+VTeqv3Ze1DqgM9U+OhQhgQWtpqwhdaEFJdzthrRFNqQsOhGCGK9sY+xYgGhXZohxZkLEg0lSEQky92SKm5o2wNpmowSNZ7BjCoaMYatGREzcNSeK6TMD9+btnKZZTPD5ncAOyyr9RUZyKmBNJIvfJzRYgtdDRjDyiO7Ubq5+yZOunC8vM21eOVpG7ArjAcSW9JbqmpeL6rW0g0DMrQdZnMaNqLsFhjtJVtDDUDMWFVqsrCUlNfMIUpQVXWUDnStqC1uiDMDNsyGSGvTNSsJNNFbNK6UmG/MkI7pN1zAKDUqxjOp3Qq5AbkZocuAhP3KfyDFah7hSuq6SooKw/1IBlkt40o2kjpW9jmVR13hIZkRGMMCA4cy0hTaGFY0daEEGirj9BnaMeCrwU1zzrk29QPpaPneJdCBtcvtGINFiejeJ/MHQ5JNZ+s5KbkmcnZszKEhiFJtdSE3FAVatCXSmcB1dh33UPXMDOtGNtZQd6RsrxyTdhcePwqv90Zqqc1i7DAxEmdpNWjaKy8itucVDaG0HQVU8kUY4MnLIzTReJBbq6hZaqxL1NVkqBeR0syOe0cNX0DQj+p1ZJV+0+U8mJ5NBMrkKY9tGJnpJu8Ako7I9psak41K9BbuT2ofErVAwRPsF0FE7sU6KK0Ro+x4ZSSVV3Xvl1FHk7KNE2hrTMl70y7osmHZlFTdbQzj2VUjrXQDyqwjfCJgGkI7dKdkiogX9U7i2IoZ4rGVAxfBEdoa4hEw+LCmybHRy+wOpIYPOUk69S2ogkKaAZrlP0KyLUxSI+RpflCktRU2pMTc2DskMI/mjLoTRWcVRYgU1WbbY+tuxyI9EUymibfkBibRWgIJTOSIXrqiklS/RZH0WcIVeywE80nwdU5JoDUgB+miqWm8vwPk/9TXROXjrpdDEHGlJPxDMQi//bBSzo0wmTWvWTwH5NoligGTR4pLj1IyRe66/IAU9XGXCnJbcVMfcXUuB21amoeZw9SSY9oqLx1J9fgKPrCOJ6I/2vnVxg7P1d02iwUqVp3FX4G3m5Df2gtwzJRjO08VqVZ4pWzSwsoSHn2eJnkoUveNh2kYjAaNyOwT3KB2vaFR6m4SvA9nRnFrS09ReKhEcqAJtC4IU2pLk5VtiZUIhmGorZRncOVOD7oHHDpzOZG2Wp6tciaenS8UsquvMVp6BcraZIqLmZUedPJnaSbhIaj8Qy2yO+0BT+WZfLj0fNhzPZwYkVY07PHgrnmtpRBDqpoFoDnYDRhZlO1LiMeNJm2a2d7HcTqziZtWmFGjiwJVJvCVBUXuvIMc+LB8Q1R9WMrK7kKrqIz6caCV1WdbT1mVFUQBDPaiYXO+gJuNqt5QFKVMOJrKJx1KhAeoQg6c4aGw5rDkjacJcOXTNxdkkudpLp81UMvq25VVfLzHDgSMubYCEkKEpHRxDjJyVypZCBGNgjNNEEZkynH5EXiTD2uX9C6LDgLqZKWU6Urik5PB64tmiuZw5swZ3XbVHi1yiUbRjttpkSZtuqblLtbWAcFIr/JyDBmSfrRenUy6XtBAbIgiC5VU8TrencLsyBNfoxcoFNFocLTCzNCs8V59xktgoSfoEv3ofckAqlvFailTGfWZAXkLQiuFaQyVUiZzI+AXoc39yLuSrVuVXT7ZK5xgkKtcEiPqlJ5AzB5MkClUHXasV3TNGZyNzTNQlV+voeSNM5VZaVlarXHyxu51GTg1GzzlbR1ZXLStuXQxArwznnfK+fRU4Mr07MqqKuQ7ILFZAkfZLKY8kaqe/LeqskvVedv8ltUoQakSmOHTH1VIalt6vwwGlMDxlN/wOTCE6CM+vebqlpBj+Wte3bSKmJtE6nv4JCabkfTk9o/Z5dV5Rw4TJGTkS2Qlut5Op/FmRp9mDrOi5l3QctUjTSUnv04psZAe/fUl0lSJj8fmZ7pQg9rMPX97qauUmbc2ONKbddrD8mHwhlLzzF0cwYxzO+XZi5Uez4H7J12zfmq49nP/69mfkeeU89iDkZQTWN+XUN8VopfKWW1VI3MUeBmLirek68nxKsc6FQMxRVCQ6Oh6F+ADisIfMyvGffJ1+P5VQYdCmlXLdSpcRYoGottdk4NXbYMjxqpKAI9+XrcbhV1L12XeQhicBcrG5OqKo54GUvOFqKe3EKeKC9dM0WpR8IFiCgWjFQHE1LVMvqoepZI5MTtPcHwydfcEYaU5luYml7LLNlnyXKX5hpMCUiQEutTzTuh/YUuJm7sNhrt42sr7+d5T3qxBx1t1CnwlGeuFTNNg0B7hUvfwjxELUUNBalRWDbzftIJUzLbv5XMi0ilVTW+bytPLvQtZPQEjruAA3ew/Ts0vHkO2X7yVVEjLCMrZa5ndjqdhv7FLktOsKrbyaSPMqSq5p2mW20/BxPidwjqWWsR3cuJB2AZ8PoY3cDiDSx7CsvPZuQUBpcDfOnVhNoKmT/5erBOpbJ8Xyn1KfkkZ2i9y8DStAZYJzik541fKYfQZ7qLJ4ycytIzGTmNBatoLcIIusPsEWbGmNjF0S0c2cLEbsJZlMNshxOexyu+gNfIHbA7xe6b8XjSMh68ZzHVamPl6QZFaFXTcli4ymVgLW4fwQzilqZb1xyuTstFOczM0h7ivNdz+qs57vw5QtfQ5+a/55rfp8+h4bL9Wv7lDFY9k6e/naWnYzSOx/guJvfguE8ax4N+qZoJJ9K7GVgwIe4A/StcBpfTv5hjO1CedSvMJUZWCXKIYnqWjS/nkj9n8YkAM8e443Nsv56x7QSzuC0WrGX50zjpVxk5CcDx2HVT2iZvfI7ey457OO7pLD/Lijce3EynSzs/FujJ1/xj0vLsG9NzwkYkKd4cYWCVS3OQgRUc2pHTwzdzSYsWy2kOs7Nc9H6e8z77m9s/xfXv5eguS9qLjrn7p/zky+z8Dq+9BgxHtrHlmzSTXUFwmgwFLDsz/Yr9d1iq2JOvBw0E1Fdoe0WNgoGFq/D6FKJYeBJhvk5TRkuydNYC7Bp5kwt/n+e8j7AL8KN/4otvYHo3/W3aLRpNvCaNJu1+Bl260/ZAm69iZiZVFELQXZqDDB1nDQ44eEdRAeDJ14NCOMoV5izXX6rYtSEsPAURF2BkfVG7rUItJKMoYvJ7RrfDqnO4+INoH+VxYDPfvII+D3HQQXG6oAmYOYAOEMXmz+FmIs1If3hwFf2j1ua05tA9KU/9ydeDikaTkea6UgrRVHAlE6xh6Wlx0LL4DLwSc6ZIPZJaCcTAcOF7UI4dq3nrx+j6OJ6d7kOJONMZx8Den7L3ZzQaOeMIYdGJKIUOQJjaz/hOOwTpydcvEpkaKuTOyqmKnTQFI6fGxrH0NFp9BEHOs9Swg3IIqwh+h0UrWH+pFc82sPuHuFIdP0YzEGfHEIc7v4ivs+PmLPYycmo6L+jIVmbGMn7nydeD2jwkRSLqKilFnqmguwwtYdFp2HkrQ8cxfDz7NiFuxW6jK0NRY5twAsOyp9ActIMFw5DZ8ZysSsE6xMEEfP6l7L6Jppu3IYPAyGmpDR7cTEgKf4nK8cAeynYSD/vMcs8e7JxckVxeLfmOroeScpfPSj8M1yWmF/+oUitdFIFmyQYGlkTy1iHKZfnZ7NmUeqkynbXQly0ZcaaFJ8Q+TOM49I9w6N6e+YXh7qvxFMrJnbUOaSiWnJRq9R+4w242ykUHBJ1Uy8ABt2VHWMzr7jmIoH2CIB1KFw2iVo10xF3dfZd4MmhU8XFdlEKiXpVOKiyjwPVQkdGb+Z0VhD5BmC5CBxzPuumHfAS3gTj2oqSK7GNqKKvAqvOjx+FaeuaqZ/HTTxdnIJaZ3LmBXPFvvXauXeCc3+S+79FSdl5r5avZshP2susv9OkbZXiNjUaBw/fgCp0pAmi6LFzP4AqUiz/Dse2M7cMFtzmHfUR21plFQ6vJguMYWIbjgmL2GOM7mTyKQLNZsYtEsweDkDCeYtm/kKUncPQ+OmN0wYHBZQyvxetDh0zu49hWpmdoudZ05nNW7TbDx9E3YqHqyX0c3casT7uRixwrjmDsEfoGWLiKviV24OvEHsa240O7ldM9pn7Zm3jBO7D62VhpqugsV56H2yD0MzOt8n4ku52ofOPl9JHMCEHNma9lx43c/K/0e3bFV+wdYcUCDQ0L1tJeaJWH/Bn23UpgWHMup1zO8RezeAPNAfv2qcNsuYbv/AlHt9Kotw/l0J3FwNpns/GVHH+R3ZmSOzK+m103c+u/sOU6Gm5OjR/wu7hNFq9n5DSWP4Xl57DsDIzwt8tpDnPmr3HK5Sw/m/7RuPOqy6G7+Nmn+clHCGZxG9Unphz8WUJY+2xOfw3HX8qitZmKwTQHN3Prx7jtyrj2ZGqva/3zOe3VnHAxQyvTv85OsP/n3PIRNn0Wt1EcU0pdn5ygu/QvYvnTIuMTE41mDX2uPJv9d+K20ijDVPUfS3aKgOB3WHo6//P21JajWfDf/SDf+wCdGVrz22aVy/QMT3kDL/0EoY/jsW8T17yTZ72X459bzIeVY09ifA+ffC5Ht+JW4evKYXqW5adz0Yc46VfsL3f8gEObMJrFG1n3zPTNP7mSb7wD0VYWQTnMdHjm/+bC/017OHfYnT9k81U85320hkon5qbf8oWXM3uoAvhXLrMzLFzHJX/JxsutP916PYc2gXDchax6mn3npi/y5dfhlPAD5TIzw9LTuPSvOfFSAH+Gbd/m8F2oBuuew9Iz7Dt//M984+14XtooXzHhNTEUh+4MGy7iNd+KZmlEY7xCxOGa3+Lmf6YRT2qqmzxS4CiLYrbDq/+TU15K2MVppKOf9m/iex/kri/R9Wm5sYnUG8fUDC/8Ky54l73L0ffOjrHrZo5sIZilbykrnsLoKXFvfhenyd1X89nLKvD1yDLOfgO/8o92v9n0eW54P4fvSkVUVp3Pyz/JonUYjfK48yq++Eo7dE2EMGT0TE56CWuezapzcTyIBFIVwAM/Yt+tTB/BaTK8jjUXMLjcOiYd4DTY/h0+fanVaSk81xMu5vLPMDAKcMfnuf49HNmWage+4K95xhWEHdwW3/sQ176HvszVRTfq9Fdw2cdpDQLc8jFu/FPGdtsjOC6XXclZryPs4ra45nf4wYdp96VbeJb4lxtV4DIzzfM/xAV/ED0CMcbYh3H3VXz+FTTi0ZDZWRZS1UZrNSEUQUj/Mt54A4vWo32Ua+eHR3HD7p9y899x95fozNBqxAPfy8ahmO3w2q9z4gsJuzge99/IDR9g/4+ZGU97Gz2Xs9/Mi/7BHhyhM8lHTmJqH46XG/U7PcsFV/CCv7GWevPf8bUr8MBrpiyTqRmOO4s3/QC3aZ/o19/BD/+JvjY6QMD36UIT3rGFRSfYTevWK7n+/zC9JxeH9i3k/HfzrPfYr4s2v/96I7d+wh4tgZLXX8prrsZtAtz6r/zXb+KB17LMN3+axhDv2EL/YoymO8s/ncTUHnt10XWd8Spe8TmrGPO9D3HNe2iBGx+hM8WC1bz9bvsVE/v4yKkEU4hTLJxJKXJA8xs/YMXTov1CpUD1cc9iYAlBJ9X3UHNp0UWbhOswuYtPXsKuH6M8EHSAiubIh6w8h8s/xZtv5ozX4PsEnfi55h2gDmm2WHRi+psffZi7voWepdmkr01/m742rsNN/8JPP27zWxFaA7QXxQPGM3D+Gb/OC/6GsIsIW67lv6+gr4nXwmh0YP8N9PHA7dz1nyn97Pzfpz1A2LWgX6NF22V4LQPL06z1Z59gbA/NPntWUYkgnOAb7+XGP0MUJrSXf85bcCROGRTdLqMn88ov4ngYza5b+NrbaDVwW+gQHdhV0R1nbIcdsN3sZ/Uz8Y1V1O/MsuY8Xv4pTADCfd/kuvfQ38JpxkfwcV1mDjG5z3r5oRWsfBp+YOcllvExq8iu6HYZOZmlZycmEQ9YNJr+EVY/mzDfdy3zaZfVNFpM3M8nn8MNf8rsuN08jIbYRJadwSs+w2uvZfhEZmeL9iFCGDCwkgXH2WqtMYw/wIBjj5A8TlE0He7/dsbT61x4KwrfZ/HxvPhjGI1yCHyue5edSV4IhCP3EY3pjuxjeDWrzsUPUwqSHzC0hkYfRluvPLmXlsKE6VnpEHEZ8Ljpzxnfgzh2EY+ewYLlBN04qFS85EpaQ+gQhOvehQlxXDtYyBLnslCjBsPCtVYEXId4/Vz2cRzPBr/XvSuNWLNHSFrMo1Bvwaq0eGlKjcomNhMDx1+Kk3p/lT5gDCddNkd3ZJ0cpw5xm+Bz/Z/wL0/hRx+xJhK100VJnQ454WLe9H1WPYPZ2SI2GsLCE3CbmBCE6cMc247okg8ymDD3y5mjTB+2Y2YtaBty0YdoDaF9xOGer7JnE41mRcRjNI7h2JY01cIweoad1kCsVr74JBtvAmM7mdhTTGqi/Eu5TE+y48b4fkJrkL5RdOTOu5z5P1h9AWEHx2PrdWz9Hi50pwm6BB37z59FFM2F6V12++Lt0OfctzNyCsEsyuXOL7DrThyDnzlCOIvfRTVoLUi3OiloO5sK9oWEuIr1L81ek5tiKQjHX8LQYmaPodwKCZj0WFWpUbRP9LcZ28LX3s7Nf81T385T30pz0O7/otABA6O86sv8yznMHMBxUsWmFDgPcByObmfmCK5XyvIFDYMr0wdw7H6mD9l3iqLbYeWZnHo5RhOVFTd9Jo8eli7Kn8rldn2Li+thySkp3nDkXjodWq1q0MwIx7bnVpLTtKbjNTjvd+POU8P932FwJe1WLtUXIewyuIrB5RhtIb7OUQTCDv2DnPvbNvLAsONGhlfSyhu9KPwOSzfSGk6PEHZy49XK4k9EnzqZVeemIFPGOAQTMrCMNRdzx+dpNZGgVstSTI2LMegAt4mnGNvGN97Frf/Ms/6Is14fV91cQp/BZZz/Lr7+bvobuRm2o6el33LobnyN5+TekLyWnpYax6G78A2ewoSIwjec/hrLVnQ8Zo6x6yY8ahMlg31+ya3KPq1IUyqy2uh14E4rEVl3B0xmwoXW+BMo6Myy5lksOwOjbUJ30Qe56IP05gZHEeXYLhR0umx8MQtW2cQKePHHePFc7OLou47uqtUu1rGSv2/Y8DKcZjYhd4vjDs98PZs+nw4Qlbl47pUhiNHWRI7dx5fewLbreMmVOJ6VCjWGk17CDe+1pdfohrpiF2j0RQc31R7cgyWnpgpxBzaRaADpgKbLCc9P37//50wcqEfJIpr1stTUgIn9GfW6gGabRettPgUcvHMO4lF7YWris8eYPozj4gesf0Ga5Acdjt3fq7yQsJ9Cn7234ik6mvUvsl5VFN1pxnbWykvaOWIGpZgd5/BdqYx6oVHW9hsEtBtsfFUaexWNI9LBXPtclpzI4a14jdREyjPb0n5cFxNWCQTEJtJwuOXfcZpcdiUR4CZC3witRUzvxWlghNCnvcDWaCzH585UJjD3LH3awyw8vvjOKCILOgyvsyGCxMYRQLOGuW5rQ+vj4DQaanaP/WoRgoCFayz4GDmpw3fj1LCdo20mOlp0d45sYeoAXhMnYOV5qQnu+B6fuiRHV6hc+xI3cIhDQ1jx1HQO/D1f4Quvod2sh45iSY/Ip0f5UeUiV4rZWTY8h9HTkyn25V4lQQd4bU5/NYG2Y55NCUrLyS8Zpmcs+6sukQkDBlvc/m/svd2meYnpkJmSMbSagZHU9RzZYjUCi0mNZmgNA6PFd0a+PIQF6/BaqajEkS1zLHTBshIj45g5ysE7ccXacTZMFmHqMGP3F3GtnOEOMHJKesse+CG+wRia/Sw6PqMcvQcNSqUKxsV/GdlQ5aJ9+uOqU/SHsV22JNnjCEkUkkii1UnHKMPpb8ptnxWKQ5HVnPF6Bvsx3WrZk3T+tAaXF3+EFeeluV91mV4I4oGU0ddP7Wf2CMqzVxjC4pNsxBqB4hO70nA1ZxyweEP+nQ/Yd0bbQMQiM3G1cHJ3Gp+XX9qn2WDluemp7vg+4weiecz265acmgYix7YzfSSHtmVvXaBZchpDq6zhItx3daS8RnOI1sJ0P+tOPTgpCw2tYRoD6RH8Gea0epGKpsiiwqzQ7TC8mpNekg1Fa4zDhCw8gRMvoxOg3Oru/Sjt9gOWnc25v8XCdbbpqPe5RmFUlC7uuZVOhKXGSr8RjSOaDnnkPman0r8W2UAb8++czr0zuTy7RIJedVE/ZHQjizdYr4Tw808W4b7RjcUwWZxqDxUYTrrMlpdF2HcHO75Ps2HxCRv2CkBjgAelU2DAG0hBYaDRP1cp32S6DHuMJnIINGe+geZQHALWGUfyespv4TqYsDjFIyujFsKGl6ADvKG5ri3EhZEz0pz57i9nFrRBxalK9Eo4PpUsw9HTa95pbC0mO7nZadW2fosiMJz8CpRD2EU57Ps593yVphcXEEphcsQvqTT90GdgAWe+LkUXfvDn+F3ERYTuMYKp9O0jJ+M+GGKsQOcYoZ85wqmonuZl6qdnkBkZFnYZGuast8bLg57GEQFWqy9g3bPxO4hTHN8kcT9So8GJL0K59C3qtQaUg+8zehorzkEHOB777+Teb8TPQNABDY8lJ6cJSF1GoEMaLos3ZN65KceYdeDI3RlEEhZtyM23zj3OgMGFnP2mNEC57vcIuukC1eUweXNVmAyOx3TAeVcwtJKwg/LYdgM//w9aDZsZzowxvicVZF5+NsvPodOxqeacVGFHMbWPqQNp6XvNM1m0hu6sRUt7zIGrk/lTEWUz4LRXM3wcWs/DOIiDu3OvSGcKFdtcHQKf5efYLbe9sManRMGUxjc870M2YAau/V2CGCGN2DSDy2OOT5QR3FvxDETQAf1L8++8J32n0XgNDm9jz62pYvqa58Ql7/yJOR7TPhe+h8FlhB2cBt//v9x7La24/mmD39UVwW+Oo6RwGkxMseHZXPiHhF2cJpMH+MqbYo1ig3KZ9dn2rTjXMCiXF/wTjSGmp+z9VG7xX+q8DE6DyQl2fC+N5ZsDvOij0GBmGpFeR5AaCUYDQUB/H+e+01ptTctcaa0bzfoXsvoZdGZRTsbWYiZ6ACf+ql1kzYXpuJP05BzQzMzgB7z4w5z0K5gQp8F1f2CfQZSvK49QGD6eRn+cwU8xtgPPrQhZtGLB2hhyVXSmGLvfapoljyrU3PzXaRa35pmsOpfpGZxm5q7B+BRn/RrPuMLWtW//NN/6A9pNG8pUB7+7mdyF10Tiy4yS54kpTryIV16FEpwGs2N87mUcux8vzlSNpqG49Z8JOmmFb/V5vPlGNvwKuEzPMjXDdPxvaoapGWZmUxDWgCP8+O8zoaFmwwt547dZ+zxCKo4wOcP0jE1fK4niysX3Oe1VLN5QyGCrcI7C5qEcLvgjdvxq2qmdurGApsP656NDBJaezvJTGLuHrs6pObT6OfFinvmHrH0WQBhy7RX88B9S7kW3Q9ihC8ddiAkJfRxhYh9Ht+NDM0j3TN2l02UGlj8tfqfH9CEm9jEd0AxwPet3Wk02XcWGT3HW6wk7KJeXfJzPXcbBrWlJy3M5/x08/y9RDjjc9Ddc9268RlFqIhsmKziylYnJdFhpxGNdtIFz3sp5v23RzAN3cdVr2fvTHL8k2tIO3MM1V/CrHwGDDjGGZWfy2q9x6D723MLhLUztIZxFHFpLGFzG0rP41rvYczuNBiak2eD+m7nh/Tz3TyywZAyrL+CN17N/M3tu4eh2pvcSdhCX9hIWrGLkNP77LRzZhtvIkX2sjnRAu49n/F4NxBm5jbqwKMoGP3MJW6+3JA+J2avdGVY9nbfcTLYleu/tHNjExG7CDs0Bhk9gxVNZuNaa2n3f5IY/ZtdPaLdsac1olj2VEy5l7UWse1buq7dez71f5d6vMr4TxyEMGVjOCS/i+Is49WUp2wrY+zPuuZq7/5ODd8TtLbHy/Iuv5KzX2bdNH+KO/2DfreiARady8ostAH/oPq5/D5u+RKuRqz4kdf9f/xIbL7dxQ2ecvbdz7H6m9hH69I0wspFVT8dxATqT3HolN76f2WM0qzp7owOe9ztc+he4jTg9NjaJK782f5mvv52ZQ6hE2V3R6fDs/8Nz/yQm4wWphy2/bvsk116BP4koW/GQTGAwPcMF/w8v+Kilej1I4wgRhx038e/PtnW4bF9a3wgbX8XqC1l2JkOr7NWWQ+L9P2P7DWy+ige+b3nFyV3TAb/+VVY+DX+a2fGcVbcX4DT59vu45Ur6+5ma4hlv45nvQQfMjuWAmuYgjQF+/lm+cUW6WKOgr+tz+mt4+v9i+dkVp7fzB9zxWX7+78yM0W6hq7jQxvDW21h6Wt2ua+vm+25nyze447McuJemg6oXBIg6ilecw3lXcOLz6R8pvmF2jP13cO/XuesLHNhKU+XzeUGEmQ5rL+C8d7LuefQtKh5h+jD77+Cer7L5CxzZZXnOFMbvCWFI3xBv/TlDK1Jo+EEYR2IfX/kf3PZZmu30uQpon04kDtTH4CqGVtK3nPZCXI/AZ/Yok3sY28n4TjoBDjSaZQDOFuqSMcwFoC0rDGRbKU3pnXEvjKgKCGi2gyuMbGRkI/1LUQ5Bh7EdHL6Ho1vwoengeFUItKB9BpbztrvTEOcrb2VyHwvXWcytM8H4Axzdxth2utqyubSeiyrr0J0lhKFRRk5l4XpawwCdcY5t48h9jO3ABxcaNUeLKD8ahpczspHhE2gNYmDmKMe2cuQ+xnfjQxPctkWVitPqHWZneP77Of99KWHvwRuHRoQj2/n4OXSnIZnzEAWnLmhCnzDMDMLMZEq2/yKq/ofzFq56+F5RZO13bWNBks65cVtHHe05Kv2veSZvvDEOfif48FqOHcmpreWuUc+7g0YhQtAhyEx5To5m+030XG0NQjhLQPEILjjxEbLzGNICvSLosnQdb7iNZn8OSJ1vQJqchA5ZdDxPfxffeh+tPkyQabMM7Kr13IrvsJJfuro14dGRJYy2BK9Jo9QNZvQc4GkIi0+O+SUNju2gM8lAKz/dcz7XWFm1BsfDUbmblhzNBHMfISrHVxwh4nAEKRSUDUJt25HmOf+X1qBND+tf7txmbjTn/i6bPsehe3Aads4NeTX7x7NIQjmdmydiPZphjRy+h263yM35RTWZwl/ops15hLK2k3LozLDxxZx0eY84dC74PNcIamj28/wPFyq4v8wvo3HiIk50qRHH5wl92SKYgMEhLv6beTp0Na9uTB1w/MWc8WY6Ge7nL619CDqgPWDFq9QTVkOm0EfiOHR9nvknLFpfCZY/JONICi4XfYjR1YRdy4n6ZVVFsPySNQyuiKNaw9FtTzwNmUI328w0xz+Lp/0v2zkxb8W5+exIhr7FPP+fY4D5l3TfUA7KYdYwvA7HjTVkDnDoLlRcUn7C7RxRW1Crnxd91BJN5ncV6kHcNR2w/oWc99sVjSe/NK+pWWanGV7B6a9B+7YtBVj+VHCZnLbdRE8gEeOIP9ztculfMnIqOpy/lnxPnKMiPNYEHT5xAXtux2vPnXQ9wUKNkAvey8ZXsnRjld0cZvsNfPO3mT5YVBZ5PFuHuHSnOeMVvPyL6NAyhef3ch9kuCt4fVz2ST5+AWFEm9DplKeyxxOTig/VDvw16fS/3Hhbk5frjxXQegTaRXKnsdmWkepJhknTW3RcR9EcYM8t3H8DnUmLARqD4+E2cVu2tJucCfmzzd6H5NJMTOcsvKFOmI/yuE2T6kbm1GCrbkSxN1rRnWXJOl7wUXs5D2bbezA7R1Zo4PZP8JU3Wkx9TpnLsvBUAbybc5ZgZRt3dVAsaVuN1EsuS16AJDmN2W5uoGZZ8KTtZHgSkgOne89Oyw7BNCYnHVz4ZZlAKlWiB+kxpTg712RGmWrD665nzYXzATZ+gZ0jadTXAWf9Bntv5Yf/SLsP/JzWYN3QQ5OZWRphvbrnLEyonlwspadOfhxEpX5E4RFqipIm0Y/tNklPqdTUm1LQz9ROIJT6kYCmtDBM/lIr7Kn3PIIa9XvHYXaaX/lH1lyY0w55BHeOpOtGaz5zKfd/h0YfYVDRZGdq5gUnIz/Ka6IwoS4rNmIk12kn9ZMNKwe1F1cq1buLmWuMb6Xqt8x7DKXpOWVRSkPFTdWkm7KoTnnUkuMyPc2Fb+OSf3polvGQjSPu3JrYx6fO5+h2nJjwUXeXy9dZqaFeN0e50on0/jpqVP1lriaAuQe2S5EeYaq0HM1cFUZTM1+g7rCV1lM9l8llZpqTLuLV18RqM/KQlfUf0kglEzK4jJdfRWMhgW+boCrHvVYGJbr+llHDjKV+YHbd3i5zTYoxNScppRkUZCPlqhHdhWlZIrktQaqurvckXpnfmO2yDn13mlUbeelnHxSq8fAZRwKrLz+bl/27dTRZsbls7b5WErV+klRh9lh26HelSITOplT1E9fLw6rLQxLpOTmkPFm+dna1qe0mMr3nT9SbiFTJeWU/ohyCWRYs49e+TP/onHXXR8w4kuD0xBfx0k8RdjGS2kfltK86qVRT03Uj+dsjpScqVfO9qR+9XjevWs9vDnTOkUmvEcxSPy2PfEQlNYme1CfqBYNLNTYUYZeBBfz611i4Af2g05OH1TgS+zj9NTz/b5mdtRT1+YRgUuWAKlSYJQZCSpGXZHYUqh6VVI0nkvzHK5s7pGZZm7KGc2lfkXorZK4Em6oY09RMvSgEZEpBgONx2RdY/pRYc5HH1DgS+3j6O7nkz5iZsVhZj4BR9ww1CnTBMm26EKjaj5jqZ2lKK0wXkqC8+lndZCuq3Ieu8YM6Y9mmZhJ9edNSmdYBRXW8IpkUOvsbpTABOFz+eY6/5CGnJ4+AcVj7CHnme7j4A8zOxmLQNawTlXlIpj7Cz94XlTWXmkdVN4XOlJQRK0eyV4o+S0/HIVWRZs4cTS+UQuYH9FElUp7rQ1H4sWVEDaoPh2U8fMYRbWs64Fnv5dIP0p21sWHlXMhksVKFdZY3iezTlcr4vKZduPB+I7UYnSk9bJ03X6mKJLInrKgYoiZV5lXIiovYcc8EWPLvlLjb1HG5/POcdNnDaBm/AM7RAxwTh1s+zDd/B/EsxdfMNUqoMmLXPYMyKSUOcx45aQEvLOjeOFhvvFJqQopKNKL4s+SaBgxzRCsJxJIaq0swTXuYyz/PuksfXst42I0jU3y58z/4ym+gfZxmrq2v9/2iBpQsG42UchZT/5H5VGrMXPGj1IQjdbiLqZrgamrC0mT70TXDLspHcF1mphk+jlf9J8ue8rBbxiNjHIl9bPsmX3kdxw7S6rOCwPMZQFd4Tqo0cjCrPqWpmLxdB5EVZlr1GKwsPcuHpirnqggppDitV6rGe9cBcb1B3ggdX34Kl3+ZkZMfCct4xIwjsY+Dm/n8r3FgM319tn+pbkotcxUyCh/UPWuzdXXRMpBvesLeBbuQ+lpGj3pHnbso4xZ13o28MxJFd4YNF/PSz9I30rsx6XFpHFHbiHKYOcyXf4N7v0arhcmO+6t/eMxZ3SgtR10fx8k8vEylp5OayrDUl4t7y/rWmUIvu8x/naMINUGXp76dF/4tynsIhfjHh3EkDZXA9X/ITX+Oo5BmsfutbiRU0TVIbsQYNV5AegKdlQVbKsfSlKqDD2Jlm+rMS8/DwirLKDa/c+lM4zR5wV/x1Hek00sesdcjbBxJt74Id32Jb7yNsYO0+2wfouk5B7V3LlNZeigSbSQ3gL0SndQ19bk62k7dqeYKHHmTMnPtlKqEy1VM13LoTrP0eF70cdY8+8ES/h6vxmEbpkOUy+Et/Pdvsv0GGnGrauGOq5qH1MO5RDuKqY9G56mtW1dm0z0rYXWl3UIq3mNUeGHsZjkeiqjdvs/Gy3nRR+gffYTCz8fKODIhqtZ8/0+58c8IAlqlLUR63nRqgvxKj2B6b/496SC99y2qho0UCbA9ndqcwU3iSZVDd5pmP8/9AOe+M43kHpXXo2gcSds+wvbv8K3fZvcmvEY8rbhM46u642YeOYvMFWMWQKoerK0enFCq/iQU5xj1lhboYZ3KwQTM+qy7gOd/mOXnpA760Xo9usaRdTHdSb7/fn7093R8mm0wtl2qvLf39gJ6Lry1HFhIT6CpLOctc0Glc3JIK+217v2RRkNnhnYf5/8h5/+Bba96VFzJY2sc+Sxm9818+w/Y+l1cwW1jgurQrMfz6DEI09SnP/R8tJVD3s1ceWyPjaoHipMrrgri4E8TwokX87y/YPnZKSnzUX89RsZhtxBtO1Fv+xg3/RmHH8BzcTw7kHbOTMGUZtn1mKVrzBxAmdSg+7WpELVMxIr+kSqeQPbrVDSPxqcbsGQdF/wxZ78xjjDUY9Vj9xgaRz4KmT7IzX/JLR9lepKmFw9jqHH/iTdR2WxCUmJH2QJMFRek4HeK0/Cqwpq6cLXH/87xZMWyMTo+Q0Oc/Xae/m76Fj0KMMbj3jiyWCpw6G5+8Bds/iwzHRoeykOHKFMb2dURq8xcGOuceW+PqLYy36EKsZWalDihAklsFgNtNr6Wp7/b6jM/iinJ4944bKuPtndk7238+K+468tMz9J0rZxQpCikqW1ZqCPtmXks+nmGCIVem3JWYupzVDKVP0cQB92lG9BqcfKvc97vsuwMaxaiHs2U5IlgHNk5hFGsuu9n3PqPbP4CU+M44LaRqmlcPYKGHkXaOtS8kmpULruXTa3HvOf0B7HCGP4MAQwu4JRX8ZS3WbOI5FkfUz/y+DaOsokc3cbPP8Udn+LwdgC3gXJBWw5RoaBv8i2svQMFVTIIU8PxqWyaLXd0qhJBKTthL/IgQRcNi9Zwxus44zdYdMLj0ywex8ZRNpHOOPf8Fz//FA/cyIyPC40mRqXj0ExPvTJTn5qqEgoyJ/mITNe86Z3dKJRCh4QdQmh6rLqQ01/LSS+nPfx4NovHvXGkWoAmjc7238adX2Dr1ezbTAAONBoYJ6OAa6o3g94+pRxCVjS6VbFHyx7EjnJVhCF+hxA8GDmFDZdx+qsYPTONweXxaxZPEOPIgSJxxh902fVDtn6Frdey/y66GgVKWWlOq+Zp5uYQJY32PQr60jPBSRr2Rdlj6i5+pH8qjJ7K6uex4WUcd75Vzo8u5HETcv5yGEd+6GQCJAc++27j/uvZcQN7b2PikPURnqAadsKejsVfpefz7pFulPcGk8zZM4QG3SXU9qv7h1m2kdUXcfwLWXFOOm4nmrX++N4qnuDGkaW5G5MrN0zu48BP2fEDdv+Ig5uZ3cOMHVII4CgcB+WkLc4SDV8VxCCGMMPtznoRk+mxMLH2RBgQxhbTgP5FLD6FlU/nuPMZfRoLV+cgHOEh97k/aRy/oJXE/RDZjXr2KEe2cmgzhzax7y7GttI5zMwx/G7alKYSirIgKtcFDoQarWNPkclmPUVzAYNLGFjNovWMnMaS01lyEgPLisVF6zvkiXtzn+jGUYLRokF2hd076DB1kMldjG1jaj+HthFMMXU/09OokO5RJsbR3fi5AtDup70QdxBHGFqNt5gFxzGwguHVDK5maDleX0W12dZU1S/HHf3/ALG/0UTVK6aYAAAAAElFTkSuQmCC">
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
  .staff-indicator-btn {
    border: none;
    background: rgba(255,255,255,0.22);
    color: #fff;
    font-size: 10.5px;
    font-weight: 700;
    border-radius: 8px;
    padding: 6px 9px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition: transform 0.1s ease, background 0.2s ease;
    flex-shrink: 0;
  }
  .staff-indicator-btn:hover { background: rgba(255,255,255,0.32); transform: scale(1.03); }
  .staff-indicator-btn:active { transform: scale(0.96); }

  .gate-card select {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid #dfe2ec;
    border-radius: 10px;
    font-size: 16px;
    margin-bottom: 12px;
    font-family: inherit;
    background: #fff;
    color: var(--text);
  }
  .staff-gate-card { max-width: 400px; }
  #staffPickSection { margin-bottom: 4px; }
  /* 「.gate-card button」より詳しいセレクタにして、ボタンの共通スタイル(幅100%の
     青いボタン)に上書きされて見た目が崩れないようにする。 */
  .gate-card .staff-manage-link {
    display: block;
    width: auto;
    margin: 10px auto 0;
    padding: 4px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--muted);
    text-decoration: underline;
    text-align: center;
    cursor: pointer;
    background: none;
    border: none;
    font-family: inherit;
  }
  .staff-manage-box {
    display: none;
    text-align: left;
    border-top: 1px solid #eef1f6;
    margin-top: 14px;
    padding-top: 16px;
  }
  .staff-manage-box.open { display: block; }
  .staff-manage-box h4 { font-size: 13px; margin: 0 0 10px; color: var(--text); }
  .staff-manage-list { list-style: none; margin: 0 0 16px; padding: 0; max-height: 160px; overflow-y: auto; }
  .staff-manage-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid #f3f4f8;
    font-size: 13px;
  }
  .staff-manage-list li span { overflow-wrap: anywhere; }
  .staff-manage-list li .staff-del-btn {
    border: none;
    background: #fdecea;
    color: #d1403a;
    font-size: 11px;
    font-weight: 700;
    border-radius: 7px;
    padding: 5px 9px;
    cursor: pointer;
    font-family: inherit;
    width: auto;
    flex-shrink: 0;
  }
  .staff-manage-empty { font-size: 13px; color: var(--muted); margin: 0 0 16px; line-height: 1.6; }
  .staff-add-row { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
  .staff-add-row input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid #dfe2ec;
    border-radius: 10px;
    font-size: 15px;
    font-family: inherit;
    margin-bottom: 0;
  }
  .gate-card .staff-add-btn { margin-top: 2px; }
  .staff-add-hint { font-size: 11.5px; color: var(--muted); margin: 6px 0 0; line-height: 1.5; }
  .staff-gate-error { color: #d1403a; font-size: 12.5px; margin-top: 8px; min-height: 16px; }
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
      <button type="button" id="staffIndicatorBtn" class="staff-indicator-btn" style="display:none;"></button>
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

  <div id="staffGate" class="gate-wrap" style="display:none;">
    <div class="gate-card staff-gate-card">
      <div id="staffPickSection">
        <h2>あなたのお名前を選択してください</h2>
        <select id="staffSelect"></select>
        <button id="staffSelectConfirm">この名前で始める</button>
      </div>
      <div class="staff-manage-empty" id="staffEmptyMsg" style="display:none;">まだ担当者が登録されていません。<br>下のフォームから最初の担当者を登録してください。</div>
      <div class="staff-gate-error" id="staffGateError"></div>

      <button type="button" class="staff-manage-link" id="staffManageToggle">担当者の追加・削除</button>
      <div class="staff-manage-box" id="staffManageBox">
        <h4>登録されている担当者</h4>
        <ul class="staff-manage-list" id="staffManageList"></ul>
        <div class="staff-add-row">
          <input type="text" id="staffNewName" placeholder="名前" />
          <input type="text" id="staffNewAccountId" placeholder="ChatworkアカウントID(数字)" inputmode="numeric" />
          <button type="button" class="staff-add-btn" id="staffAddBtn">この内容で追加する</button>
        </div>
        <div class="staff-add-hint">ChatworkアカウントIDは、Chatworkのプロフィール画面に出ている数字のIDです。</div>
      </div>
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
  var STAFF_KEY = 'shpStaffIdentity';
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

  // この端末で選んだ担当者(名前・ChatworkアカウントID)は、毎回選び直さなくて
  // 済むよう、この端末のlocalStorageに覚えておく。接客担当ページと同じ場所
  // (同じキー)に保存するため、同じ端末であれば両方のページで共有される。
  function getStoredStaff() {
    try {
      var raw = window.localStorage.getItem(STAFF_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && obj.accountId) return obj;
      return null;
    } catch (e) { return null; }
  }
  function setStoredStaff(staff) {
    try { window.localStorage.setItem(STAFF_KEY, JSON.stringify(staff)); } catch (e) { /* 無視 */ }
  }
  function clearStoredStaff() {
    try { window.localStorage.removeItem(STAFF_KEY); } catch (e) { /* 無視 */ }
  }

  var gateWrap = qs('gate');
  var adminWrap = qs('adminWrap');
  var gateSubmit = qs('gate-submit');
  var gatePassword = qs('gate-password');
  var gateError = qs('gate-error');
  var staffIndicatorBtn = qs('staffIndicatorBtn');
  var staffGateWrap = qs('staffGate');
  var staffPickSection = qs('staffPickSection');
  var staffSelect = qs('staffSelect');
  var staffEmptyMsg = qs('staffEmptyMsg');
  var staffSelectConfirm = qs('staffSelectConfirm');
  var staffGateError = qs('staffGateError');
  var staffManageToggle = qs('staffManageToggle');
  var staffManageBox = qs('staffManageBox');
  var staffManageList = qs('staffManageList');
  var staffNewName = qs('staffNewName');
  var staffNewAccountId = qs('staffNewAccountId');
  var staffAddBtn = qs('staffAddBtn');
  var listBody = qs('listBody');
  var pendingCount = qs('pendingCount');
  var refreshButton = qs('refreshButton');
  var refreshTimer = null;

  function showGate(message) {
    clearStoredPassword();
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    gateWrap.style.display = 'flex';
    staffGateWrap.style.display = 'none';
    adminWrap.style.display = 'none';
    gateError.textContent = message || '';
  }

  function enterAdminForReal() {
    gateWrap.style.display = 'none';
    staffGateWrap.style.display = 'none';
    adminWrap.style.display = 'flex';
    loadPending();
    if (!refreshTimer) {
      refreshTimer = setInterval(loadPending, REFRESH_INTERVAL_MS);
    }
  }

  // ===== 担当者(名前)の選択 =====
  // 誰が回答したかを記録・通知できるよう、ログイン後に名前を一度選んでもらい、
  // この端末に覚えておく。担当者の追加・削除もこの画面から行える。
  // (接客担当ページと同じ一覧・同じAPIを使う。)
  function renderStaffIndicator(staff) {
    if (!staffIndicatorBtn) return;
    if (staff && staff.name) {
      staffIndicatorBtn.style.display = 'inline-flex';
      staffIndicatorBtn.textContent = '👤 ' + staff.name;
    } else {
      staffIndicatorBtn.style.display = 'none';
      staffIndicatorBtn.textContent = '';
    }
  }

  function populateStaffSelect(list) {
    var hasStaff = !!(list && list.length > 0);

    if (staffPickSection) staffPickSection.style.display = hasStaff ? 'block' : 'none';
    if (staffEmptyMsg) staffEmptyMsg.style.display = hasStaff ? 'none' : 'block';
    if (staffManageToggle) staffManageToggle.style.display = hasStaff ? 'block' : 'none';
    if (staffManageBox && !hasStaff) staffManageBox.classList.add('open');

    if (!staffSelect) return;
    staffSelect.innerHTML = '';
    if (!hasStaff) return;
    list.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.accountId;
      opt.textContent = s.name;
      staffSelect.appendChild(opt);
    });
    var stored = getStoredStaff();
    if (stored && list.some(function (s) { return s.accountId === stored.accountId; })) {
      staffSelect.value = stored.accountId;
    }
  }

  function populateStaffManageList(list) {
    if (!staffManageList) return;
    staffManageList.innerHTML = '';
    if (!list || list.length === 0) return;
    list.forEach(function (s) {
      var li = document.createElement('li');
      var nameSpan = document.createElement('span');
      nameSpan.textContent = s.name + '(ID:' + s.accountId + ')';
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'staff-del-btn';
      delBtn.textContent = '削除';
      delBtn.setAttribute('data-account-id', s.accountId);
      li.appendChild(nameSpan);
      li.appendChild(delBtn);
      staffManageList.appendChild(li);
    });
  }

  function fetchStaffList() {
    return fetch('/api/staff-list', {
      headers: { 'x-promoter-password': getStoredPassword() }
    })
      .then(function (res) { return res.json(); })
      .then(function (data) { return (data && data.items) || []; });
  }

  function showStaffGate() {
    gateWrap.style.display = 'none';
    adminWrap.style.display = 'none';
    staffGateWrap.style.display = 'flex';
    if (staffGateError) staffGateError.textContent = '';
    fetchStaffList()
      .then(function (list) {
        populateStaffSelect(list);
        populateStaffManageList(list);
      })
      .catch(function () {
        if (staffGateError) staffGateError.textContent = '担当者一覧の取得に失敗しました。もう一度お試しください。';
      });
  }

  // パスワードでのログインが済んだあと、この端末に覚えている担当者が
  // まだ(削除などで)有効かどうかを確認してから、回答管理画面に進む。
  function ensureStaffIdentityThenEnterAdmin() {
    var stored = getStoredStaff();
    fetchStaffList()
      .then(function (list) {
        if (stored && list.some(function (s) { return s.accountId === stored.accountId; })) {
          renderStaffIndicator(stored);
          enterAdminForReal();
        } else {
          clearStoredStaff();
          renderStaffIndicator(null);
          populateStaffSelect(list);
          populateStaffManageList(list);
          gateWrap.style.display = 'none';
          adminWrap.style.display = 'none';
          staffGateWrap.style.display = 'flex';
          if (staffGateError) staffGateError.textContent = '';
        }
      })
      .catch(function () {
        // 担当者一覧が取れなくても、回答自体はできるようにしておく。
        enterAdminForReal();
      });
  }

  function showAdmin() {
    gateWrap.style.display = 'none';
    adminWrap.style.display = 'none';
    ensureStaffIdentityThenEnterAdmin();
  }

  if (staffSelectConfirm) {
    staffSelectConfirm.addEventListener('click', function () {
      if (!staffSelect || !staffSelect.value) {
        if (staffGateError) staffGateError.textContent = '名前を選択してください。';
        return;
      }
      var selectedOpt = staffSelect.options[staffSelect.selectedIndex];
      var staff = { accountId: staffSelect.value, name: selectedOpt ? selectedOpt.textContent : '' };
      setStoredStaff(staff);
      renderStaffIndicator(staff);
      enterAdminForReal();
    });
  }

  if (staffIndicatorBtn) {
    staffIndicatorBtn.addEventListener('click', showStaffGate);
  }

  if (staffManageToggle) {
    staffManageToggle.addEventListener('click', function () {
      if (staffManageBox) staffManageBox.classList.toggle('open');
    });
  }

  if (staffAddBtn) {
    staffAddBtn.addEventListener('click', function () {
      var name = (staffNewName && staffNewName.value || '').trim();
      var accountId = (staffNewAccountId && staffNewAccountId.value || '').trim();
      if (!name || !accountId) {
        if (staffGateError) staffGateError.textContent = '名前とChatworkアカウントIDの両方を入力してください。';
        return;
      }
      if (!/^[0-9]+$/.test(accountId)) {
        if (staffGateError) staffGateError.textContent = 'ChatworkアカウントIDは数字で入力してください。';
        return;
      }
      if (staffGateError) staffGateError.textContent = '';
      staffAddBtn.disabled = true;
      fetch('/api/staff-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-promoter-password': getStoredPassword() },
        body: JSON.stringify({ name: name, accountId: accountId })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || !data.ok) {
            if (staffGateError) staffGateError.textContent = '追加に失敗しました。もう一度お試しください。';
            return;
          }
          if (staffNewName) staffNewName.value = '';
          if (staffNewAccountId) staffNewAccountId.value = '';
          return fetchStaffList().then(function (list) {
            populateStaffSelect(list);
            populateStaffManageList(list);
          });
        })
        .catch(function () {
          if (staffGateError) staffGateError.textContent = '通信エラーが発生しました。もう一度お試しください。';
        })
        .finally(function () {
          staffAddBtn.disabled = false;
        });
    });
  }

  if (staffManageList) {
    staffManageList.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.staff-del-btn') : null;
      if (!btn) return;
      var accountId = btn.getAttribute('data-account-id');
      if (!accountId) return;
      if (!window.confirm('この担当者を削除しますか？')) return;
      btn.disabled = true;
      fetch('/api/staff-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-promoter-password': getStoredPassword() },
        body: JSON.stringify({ accountId: accountId })
      })
        .then(function (res) { return res.json(); })
        .then(function () {
          var stored = getStoredStaff();
          if (stored && stored.accountId === accountId) {
            clearStoredStaff();
            renderStaffIndicator(null);
          }
          return fetchStaffList().then(function (list) {
            populateStaffSelect(list);
            populateStaffManageList(list);
          });
        })
        .catch(function () {
          if (staffGateError) staffGateError.textContent = '削除に失敗しました。もう一度お試しください。';
        });
    });
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
        var answeringStaff = getStoredStaff();
        fetch('/api/promoter-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-promoter-password': getStoredPassword() },
          body: JSON.stringify({
            id: item.id,
            answer: answer,
            staffName: answeringStaff ? answeringStaff.name : '',
            staffAccountId: answeringStaff ? answeringStaff.accountId : ''
          })
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

// ブラウザのプッシュ通知(質問受付ページを閉じていても回答に気づける機能)用の
// サービスワーカー。質問受付ページ(buildChatPageHtml)から './sw.js' として読み込まれる。
// ※ shp-company.site側の静的ページ(qa_bot_index.html)で使う場合は、この内容を
//   同じ内容のsw.jsというファイルとして、ページと同じフォルダに置く必要がある
//   (サービスワーカーは、それを読み込んだページと同じ場所に置かないと動かないため)。
// 通知に表示するアイコン(質問受付ページのロゴと同じ画像)。これが無いと、
// Chromeなどの通知がどのサイトからのものか分かりにくく見落とされやすいため付けている。
const PUSH_ICON_DATA_URI = 'data:image/png;base64,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';

const SW_JS_CONTENT = `
// 通知に表示するアイコン(質問受付ページのロゴと同じ画像)。
var PUSH_ICON_DATA_URI = '${PUSH_ICON_DATA_URI}';

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'SHP 自動回答チャット', body: event.data ? event.data.text() : '新しいお知らせがあります。' };
  }
  var title = data.title || 'SHP 自動回答チャット';
  var options = {
    body: data.body || '新しいお知らせがあります。',
    icon: data.icon || PUSH_ICON_DATA_URI,
    badge: data.badge || PUSH_ICON_DATA_URI,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(url) !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
`;

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

['/api/ask-login', '/api/ask', '/api/ask-list', '/api/ask-status', '/api/ask-delete', '/api/ask-hide', '/api/promoter-login', '/api/promoter-pending', '/api/promoter-answer', '/api/promoter-delete', '/api/push-subscribe', '/api/staff-list', '/api/staff-add', '/api/staff-delete'].forEach(
  (path) => {
    app.options(path, (req, res) => {
      allowCors(req, res);
      res.sendStatus(204);
    });
  }
);

// Render側(/chat)の質問受付ページ用のサービスワーカー配信。
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(SW_JS_CONTENT);
});

// プッシュ通知に使う公開鍵(VAPID公開鍵)をクライアントに渡す。公開鍵なので
// パスワードでは保護しない(秘密鍵の方は環境変数のみに置き、絶対に公開しない)。
app.get('/api/push-public-key', (req, res) => {
  allowCors(req, res);
  res.json({ publicKey: config.vapidPublicKey || '' });
});

// 質問受付ページでブラウザ通知を有効にした人の購読情報を保存する。
app.post('/api/push-subscribe', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkChatPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const subscription = req.body && req.body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'subscription is required' });
    }
    await appendPushSubscriptionRow(subscription);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/push-subscribe エラー:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

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
async function createSitePendingAndNotify(question, staff = null) {
  let pendingId = null;
  try {
    pendingId = await appendPendingRow({
      question,
      askerAccountId: staff ? staff.accountId : '',
      askerName: staff ? staff.name : '接客担当(自社サイト)',
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
      // 固定の環境変数(HOLDER_ACCOUNT_IDS)ではなく、サイト内の「担当者」一覧
      // (Bot_Staff、追加・削除した人)全員にTOを付けて知らせる。
      const staffMembers = await listStaffMembers();
      const mentions = staffMembers.map((s) => mentionTag(s.accountId, s.name)).join(' ');
      const mentionPrefix = mentions ? `${mentions}\n` : '';
      await sendMessage(
        mentionPrefix
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
async function recordSiteAnswered(question, answer, staff = null) {
  try {
    return await appendPendingRow({
      question,
      askerAccountId: staff ? staff.accountId : '',
      askerName: staff ? staff.name : '接客担当(自社サイト)',
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

    const staffName = ((req.body && req.body.staffName) || '').trim();
    const staffAccountId = ((req.body && req.body.staffAccountId) || '').trim();
    const staff = staffAccountId ? { name: staffName, accountId: staffAccountId } : null;

    const { rows } = await readFaqTable();
    let result = exactMatchQuestion(question, rows);

    if (result.matched && result.answer) {
      const id = await recordSiteAnswered(question, result.answer, staff);
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
          const id = await recordSiteAnswered(question, answerBody, staff);
          return res.json({ answered: true, answer: answerBody, id });
        }
        const pendingId = await createSitePendingAndNotify(leftover, staff);
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
      const id = await recordSiteAnswered(question, result.answer, staff);
      return res.json({ answered: true, answer: result.answer, id });
    }

    // Q&A表に答えが無い場合は、保留シートに記録したうえで、プロモーター用の
    // 回答管理ページ(/promoter)で回答してもらう。
    const pendingId = await createSitePendingAndNotify(question, staff);

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

// 質問受付ページで名前を選ぶための一覧。
app.get('/api/staff-list', async (req, res) => {
  allowCors(req, res);
  if (!checkChatOrPromoterPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const staff = await listStaffMembers();
    return res.json({ items: staff.map((s) => ({ name: s.name, accountId: s.accountId })) });
  } catch (e) {
    console.error('/api/staff-list エラー:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/staff-add', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkChatOrPromoterPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const name = ((req.body && req.body.name) || '').trim();
    const accountId = ((req.body && req.body.accountId) || '').trim();
    if (!name || !accountId) return res.status(400).json({ error: 'name and accountId are required' });
    if (!/^[0-9]+$/.test(accountId)) {
      return res.status(400).json({ error: 'accountId must be numeric' });
    }
    await upsertStaffMember(name, accountId);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/staff-add エラー:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/staff-delete', express.json(), async (req, res) => {
  allowCors(req, res);
  if (!checkChatOrPromoterPassword(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const accountId = ((req.body && req.body.accountId) || '').trim();
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    await removeStaffMember(accountId);
    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/staff-delete エラー:', e);
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
    const staffName = ((req.body && req.body.staffName) || '').trim();
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
      answeredBy: staffName ? `${staffName}(サイト管理画面)` : 'プロモーター(サイト管理画面)',
      answeredAt: new Date().toISOString(),
    });

    // 質問受付ページを閉じていても気づけるよう、通知を有効にしている端末全員に
    // ブラウザのプッシュ通知を送る(送信に失敗しても回答自体は完了させる)。
    sendPushToAllSubscribers({
      title: '質問に回答が届きました',
      body: target.question.length > 40 ? target.question.slice(0, 40) + '…' : target.question,
      url: 'https://shp-company.site/qa_bot/',
    }).catch((e) => console.error('プッシュ通知の送信中にエラーが発生しました:', e));

    // ブラウザの通知に気づけなかった場合の保険として、Chatworkにも
    // 「回答しました」という通知を送る。質問を受け付けた担当者がわかっている場合は
    // その人にTOを付けて知らせる(わからない場合は誰にもメンションしない)。
    try {
      const mentionPrefix = target.askerAccountId
        ? `${mentionTag(target.askerAccountId, target.askerName)}\n`
        : '';
      await sendMessage(
        mentionPrefix
        + `サイト内の質問に回答しました。\n\n`
        + `【質問】\n${target.question}\n\n`
        + `【回答】\n${answer}\n\n`
        + `▼質問受付ページはこちら\nhttps://shp-company.site/qa_bot/`
      );
    } catch (e) {
      console.error('Chatworkへの回答済み通知の送信に失敗しました:', e);
    }

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
