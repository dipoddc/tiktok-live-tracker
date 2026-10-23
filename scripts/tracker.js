#!/usr/bin/env node
/**
 * TikTok Live Performance Tracker
 * --------------------------------
 * - Konek ke WebSocket live TikTok (tiktok-live-connector v2, ESM).
 * - Catat current viewers, peak viewers, total likes, durasi, follow, share, dan chat.
 * - Kirim snapshot live tiap ~15 detik ke branch `live-<username>` (dibaca dashboard).
 * - Saat live selesai: simpan ringkasan ke data/history/<username>_history.json
 *   (hanya 90 hari terakhir), lalu buat:
 *     out/Session_<username>_<stamp>.xlsx       (laporan sesi + chat log lengkap)
 *     out/Report_<username>_3_Months.xlsx       (Summary 3 Bulan + 1 sheet per sesi)
 * - Akun offline / gagal konek => exit 0 (graceful).
 *
 * Pemakaian:
 *   node scripts/tracker.js <username>
 *
 * Environment (opsional):
 *   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA  -> untuk publish snapshot live (otomatis di Actions)
 *   EULER_API_KEY                               -> API key sign server Euler Stream (opsional)
 *   TT_CONNECT_WITH_UNIQUE_ID=true              -> pakai opsi connectWithUniqueId (kalau kena captcha)
 *   MAX_LIVE_MINUTES=160                        -> batas tracking per run
 *   SNAPSHOT_INTERVAL_SEC=15                    -> interval publish snapshot live
 *   SESSION_STAMP=YYYYMMDD_HHmmss                -> disamakan dengan recorder
 *   RELEASE_TAG=live-<user>-<stamp>              -> dicatat di histori untuk link download
 *   OUT_DIR=out, RETENTION_DAYS=90, LIVE_BRANCH_PREFIX=live-, PUBLISH_LIVE_STATUS=true
 */

import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import * as TTL from 'tiktok-live-connector';

const { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig, UserOfflineError } = TTL;
// v2.5+: streamEnd ada di WebcastEvent; versi lama di ControlEvent
const STREAM_END_EVENT = WebcastEvent?.STREAM_END || ControlEvent?.STREAM_END || 'streamEnd';

// ---------------------------------------------------------------------------
// Konstanta & path
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const HISTORY_DIR = path.join(ROOT, 'data', 'history');
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || 'out');

const TZ = 'Asia/Jakarta';
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);
const MAX_LIVE_MINUTES = Number(process.env.MAX_LIVE_MINUTES || 160);
const SNAPSHOT_INTERVAL_MS = Math.max(10, Number(process.env.SNAPSHOT_INTERVAL_SEC || 15)) * 1000;
const SAMPLE_INTERVAL_MS = 60_000;
const IDLE_CHECK_MS = 5 * 60_000;
const CONNECT_ATTEMPTS = 3;
const RECONNECT_ATTEMPTS = 5;
const SNAPSHOT_CHAT_LIMIT = 100;
const LIVE_BRANCH_PREFIX = process.env.LIVE_BRANCH_PREFIX || 'live-';
const USERNAME_RE = /^[a-z0-9._]{2,24}$/;

const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPOSITORY || '';

const STOPWORDS = new Set([
  // Indonesia + slang
  'yang', 'dan', 'di', 'ke', 'dari', 'ini', 'itu', 'aja', 'saja', 'ada', 'apa', 'kak', 'kakak', 'bang', 'mas', 'mbak',
  'min', 'nya', 'dong', 'deh', 'sih', 'kok', 'kan', 'lah', 'yah', 'ya', 'iya', 'gak', 'ga', 'nggak', 'enggak', 'tidak',
  'bisa', 'mau', 'udah', 'sudah', 'belum', 'jadi', 'buat', 'untuk', 'sama', 'dengan', 'juga', 'lagi', 'tapi', 'kalau',
  'kalo', 'atau', 'karena', 'aku', 'saya', 'gue', 'gua', 'gw', 'lo', 'lu', 'kamu', 'dia', 'kita', 'kami', 'mereka',
  'pak', 'bu', 'bro', 'sis', 'om', 'tante', 'haha', 'hahaha', 'wkwk', 'wkwkwk', 'wkwkwkwk', 'hehe', 'hihi', 'hai',
  'halo', 'hallo', 'hello', 'banget', 'bgt', 'yg', 'dgn', 'utk', 'tdk', 'sdh', 'blm', 'krn', 'trs', 'terus', 'nih',
  'tuh', 'gimana', 'bagaimana', 'berapa', 'kapan', 'dimana', 'mana', 'siapa', 'kenapa', 'emang', 'memang', 'masih',
  'pun', 'akan', 'oleh', 'pada', 'dalam', 'para', 'semua', 'satu', 'dua', 'tiga', 'lebih', 'kurang', 'boleh',
  // English
  'the', 'and', 'you', 'for', 'are', 'with', 'this', 'that', 'have', 'from', 'your', 'what', 'just', 'not', 'but',
  'all', 'can', 'was', 'its', 'too', 'very', 'lol', 'omg', 'yes', 'nice', 'joined', 'hii', 'hiii'
]);

// ---------------------------------------------------------------------------
// Utilitas umum
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => (e && (e.message || e.toString())) || String(e);

function wibParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}
export function fmtWIB(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const o = wibParts(d);
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}:${o.second}`;
}
export function stampWIB(date = new Date()) {
  const o = wibParts(date);
  return `${o.year}${o.month}${o.day}_${o.hour}${o.minute}${o.second}`;
}
export function fmtDuration(totalSec) {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function log(...args) {
  console.log(`[tracker ${fmtWIB(new Date())}]`, ...args);
}
function warn(...args) {
  console.warn(`[tracker ${fmtWIB(new Date())}] PERINGATAN:`, ...args);
}

export function normalizeUsername(raw) {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    warn(`Gagal membaca ${CONFIG_PATH}: ${errMsg(e)}`);
    return {};
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Ambil nilai pertama yang terdefinisi dari beberapa path (a.b.c) di objek. */
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    for (const k of p.split('.')) {
      if (cur == null) break;
      cur = cur[k];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Histori 90 hari
// ---------------------------------------------------------------------------
export function historyPath(username, dir = HISTORY_DIR) {
  return path.join(dir, `${username}_history.json`);
}

export function loadHistory(username, dir = HISTORY_DIR) {
  const file = historyPath(username, dir);
  if (!fs.existsSync(file)) {
    return { username, retention_days: RETENTION_DAYS, updated_at: null, sessions: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return { username, retention_days: RETENTION_DAYS, updated_at: null, sessions: parsed };
    if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
    return parsed;
  } catch (e) {
    warn(`File histori rusak (${file}): ${errMsg(e)}. Dibuat ulang dari kosong; file lama di-backup.`);
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`); } catch { /* abaikan */ }
    return { username, retention_days: RETENTION_DAYS, updated_at: null, sessions: [] };
  }
}

export function pruneSessions(sessions, now = new Date(), days = RETENTION_DAYS) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return sessions
    .filter((s) => {
      const t = new Date(s.ended_at || s.tracking_started_at || s.live_started_at || 0).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => new Date(sessionStart(a)) - new Date(sessionStart(b)));
}

export function saveHistory(history, dir = HISTORY_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  history.retention_days = RETENTION_DAYS;
  history.updated_at = new Date().toISOString();
  fs.writeFileSync(historyPath(history.username, dir), JSON.stringify(history, null, 2) + '\n');
}

function sessionStart(s) {
  return s.live_started_at || s.tracking_started_at || s.ended_at;
}

// ---------------------------------------------------------------------------
// Analisis komentar
// ---------------------------------------------------------------------------
export function extractKeywords(chats, limit = 30) {
  const counts = new Map();
  for (const c of chats) {
    const text = String(c.comment || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/@[\w.]+/g, ' ');
    const words = text.match(/[\p{L}\p{N}]+/gu) || [];
    const seen = new Set();
    for (const w of words) {
      if (w.length < 3 || /^\d+$/.test(w) || STOPWORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

export function topCommenters(commenterMap, limit = 20) {
  return [...commenterMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((c) => ({ user: c.user, nickname: c.nickname, count: c.count }));
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  row.height = 22;
}

function safeSheetName(name, used) {
  let base = String(name).replace(/[\[\]\*\?\/\\:]/g, '.').slice(0, 31);
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

const END_REASON_LABEL = {
  stream_end: 'Live diakhiri host',
  disconnected: 'Koneksi terputus',
  max_duration: 'Batas durasi run tercapai',
  signal: 'Dihentikan (sinyal/timeout)',
  idle_offline: 'Live tidak aktif lagi'
};

export const SUMMARY_COLUMNS = [
  { header: 'No', key: 'no', width: 5 },
  { header: 'Tanggal (WIB)', key: 'date', width: 13 },
  { header: 'Mulai Live (WIB)', key: 'start', width: 20 },
  { header: 'Selesai (WIB)', key: 'end', width: 20 },
  { header: 'Durasi', key: 'dur', width: 10 },
  { header: 'Durasi (menit)', key: 'durMin', width: 10 },
  { header: 'Peak Viewers', key: 'peak', width: 11 },
  { header: 'Avg Viewers', key: 'avg', width: 11 },
  { header: 'Total Likes', key: 'likes', width: 12 },
  { header: 'Komentar', key: 'comments', width: 10 },
  { header: 'Komentator Unik', key: 'unique', width: 11 },
  { header: 'Follow Baru', key: 'follows', width: 9 },
  { header: 'Share', key: 'shares', width: 8 },
  { header: 'Judul Live', key: 'title', width: 36 },
  { header: 'Alasan Selesai', key: 'reason', width: 24 },
  { header: 'Release Tag', key: 'tag', width: 34 }
];

export function sessionToSummaryRow(s, i) {
  const start = sessionStart(s);
  return {
    no: i + 1,
    date: fmtWIB(start).slice(0, 10),
    start: fmtWIB(start),
    end: fmtWIB(s.ended_at),
    dur: fmtDuration(s.duration_sec),
    durMin: Math.round(num(s.duration_sec) / 60),
    peak: num(s.peak_viewers),
    avg: num(s.avg_viewers),
    likes: num(s.total_likes),
    comments: num(s.total_comments),
    unique: num(s.unique_commenters),
    follows: num(s.follows),
    shares: num(s.shares),
    title: s.title || '',
    reason: END_REASON_LABEL[s.end_reason] || s.end_reason || '',
    tag: s.release_tag || ''
  };
}

function addKeyValueBlock(ws, startRow, rows) {
  rows.forEach(([k, v], idx) => {
    const r = ws.getRow(startRow + idx);
    r.getCell(1).value = k;
    r.getCell(1).font = { bold: true };
    r.getCell(2).value = v;
  });
  return startRow + rows.length;
}

/** Sheet detail 1 sesi: info, timeline viewers, top commenter, top keyword. */
export function addSessionDetailSheet(wb, sheetName, s) {
  const ws = wb.addWorksheet(sheetName);
  ws.columns = [
    { width: 24 }, { width: 22 }, { width: 3 },
    { width: 6 }, { width: 22 }, { width: 22 }, { width: 10 }, { width: 3 },
    { width: 6 }, { width: 20 }, { width: 14 }
  ];

  ws.getCell('A1').value = `Detail Sesi Live @${s.username}`;
  ws.getCell('A1').font = { bold: true, size: 14 };

  let row = addKeyValueBlock(ws, 3, [
    ['Judul Live', s.title || '-'],
    ['Room ID', s.room_id || '-'],
    ['Mulai Live (WIB)', fmtWIB(s.live_started_at) || '(tidak diketahui)'],
    ['Mulai Tracking (WIB)', fmtWIB(s.tracking_started_at)],
    ['Selesai (WIB)', fmtWIB(s.ended_at)],
    ['Durasi Live', fmtDuration(s.duration_sec)],
    ['Durasi Ter-track', fmtDuration(s.tracked_duration_sec)],
    ['Peak Viewers', num(s.peak_viewers)],
    ['Waktu Peak (WIB)', fmtWIB(s.peak_viewers_at) || '-'],
    ['Avg Viewers', num(s.avg_viewers)],
    ['Total Likes', num(s.total_likes)],
    ['Total Komentar', num(s.total_comments)],
    ['Komentator Unik', num(s.unique_commenters)],
    ['Follow Baru', num(s.follows)],
    ['Share', num(s.shares)],
    ['Alasan Selesai', END_REASON_LABEL[s.end_reason] || s.end_reason || '-'],
    ['Release Tag', s.release_tag || '-']
  ]);

  row += 1;
  const tStart = row;

  // Timeline viewers (kolom A-B)
  const th = ws.getRow(tStart);
  th.getCell(1).value = 'Waktu (WIB)';
  th.getCell(2).value = 'Viewers';
  // Top commenter (kolom D-G)
  th.getCell(4).value = '#';
  th.getCell(5).value = 'Username';
  th.getCell(6).value = 'Nickname';
  th.getCell(7).value = 'Komentar';
  // Top keyword (kolom I-K)
  th.getCell(9).value = '#';
  th.getCell(10).value = 'Kata Kunci';
  th.getCell(11).value = 'Jml Komentar';
  styleHeaderRow(th); // eachCell hanya menyentuh sel berisi, kolom pemisah C & H tetap polos

  (s.viewer_timeline || []).forEach((p, i) => {
    const r = ws.getRow(tStart + 1 + i);
    r.getCell(1).value = fmtWIB(p.t);
    r.getCell(2).value = num(p.v);
  });
  (s.top_commenters || []).forEach((c, i) => {
    const r = ws.getRow(tStart + 1 + i);
    r.getCell(4).value = i + 1;
    r.getCell(5).value = c.user;
    r.getCell(6).value = c.nickname || '';
    r.getCell(7).value = num(c.count);
  });
  (s.top_keywords || []).forEach((k, i) => {
    const r = ws.getRow(tStart + 1 + i);
    r.getCell(9).value = i + 1;
    r.getCell(10).value = k.word;
    r.getCell(11).value = num(k.count);
  });

  ws.views = [{ state: 'frozen', ySplit: tStart }];
  return ws;
}

export async function buildSessionReport(session, chats, filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TikTok Live Tracker';
  wb.created = new Date();

  addSessionDetailSheet(wb, 'Ringkasan Sesi', session);

  const ws = wb.addWorksheet('Chat Log');
  ws.columns = [
    { header: 'No', key: 'no', width: 7 },
    { header: 'Waktu (WIB)', key: 'time', width: 20 },
    { header: 'Username', key: 'user', width: 24 },
    { header: 'Nickname', key: 'nick', width: 24 },
    { header: 'Komentar', key: 'comment', width: 80 }
  ];
  styleHeaderRow(ws.getRow(1));
  chats.forEach((c, i) => {
    ws.addRow({ no: i + 1, time: fmtWIB(c.time), user: c.user, nick: c.nickname || '', comment: c.comment });
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (chats.length) ws.autoFilter = { from: 'A1', to: `E${chats.length + 1}` };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

export async function buildThreeMonthReport(history, filePath) {
  const sessions = [...history.sessions].sort((a, b) => new Date(sessionStart(a)) - new Date(sessionStart(b)));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TikTok Live Tracker';
  wb.created = new Date();
  const used = new Set();

  const ws = wb.addWorksheet(safeSheetName('Summary 3 Bulan', used));
  ws.getCell('A1').value = `Rekap Live @${history.username} - ${RETENTION_DAYS} hari terakhir`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = `Dibuat: ${fmtWIB(new Date())} WIB | Jumlah sesi: ${sessions.length}`;

  const headerRowIdx = 4;
  const hr = ws.getRow(headerRowIdx);
  SUMMARY_COLUMNS.forEach((c, i) => {
    hr.getCell(i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width;
  });
  styleHeaderRow(hr);

  sessions.forEach((s, i) => {
    const data = sessionToSummaryRow(s, i);
    const r = ws.getRow(headerRowIdx + 1 + i);
    SUMMARY_COLUMNS.forEach((c, ci) => { r.getCell(ci + 1).value = data[c.key]; });
  });

  if (sessions.length) {
    const first = headerRowIdx + 1;
    const last = headerRowIdx + sessions.length;
    const tr = ws.getRow(last + 1);
    tr.getCell(1).value = 'TOTAL / RATA2';
    tr.getCell(6).value = { formula: `SUM(F${first}:F${last})` };
    tr.getCell(7).value = { formula: `ROUND(AVERAGE(G${first}:G${last}),0)` };
    tr.getCell(8).value = { formula: `ROUND(AVERAGE(H${first}:H${last}),0)` };
    tr.getCell(9).value = { formula: `SUM(I${first}:I${last})` };
    tr.getCell(10).value = { formula: `SUM(J${first}:J${last})` };
    tr.getCell(12).value = { formula: `SUM(L${first}:L${last})` };
    tr.getCell(13).value = { formula: `SUM(M${first}:M${last})` };
    tr.font = { bold: true };
    ws.getRow(last + 2).getCell(1).value = 'Catatan: Peak & Avg Viewers di baris total = rata-rata antar sesi; kolom lain = jumlah.';
    ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: last, column: SUMMARY_COLUMNS.length } };
  } else {
    ws.getRow(headerRowIdx + 1).getCell(1).value = 'Belum ada sesi live tercatat.';
  }
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];

  sessions.forEach((s, i) => {
    const o = wibParts(new Date(sessionStart(s)));
    const name = safeSheetName(`#${String(i + 1).padStart(2, '0')} ${o.year}-${o.month}-${o.day} ${o.hour}.${o.minute}`, used);
    addSessionDetailSheet(wb, name, s);
  });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Publish snapshot live ke branch `live-<username>` lewat git push.
// Selalu 1 commit (di-amend) + force push: branch tetap kecil, tidak kena limit
// "content creation" REST API GitHub, dan tidak memicu build GitHub Pages.
// ---------------------------------------------------------------------------
function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(String(stdout));
    });
  });
}

export class LiveBranchPublisher {
  constructor(username) {
    this.enabled = Boolean(GH_TOKEN && GH_REPO) && process.env.PUBLISH_LIVE_STATUS !== 'false';
    this.branch = `${LIVE_BRANCH_PREFIX}${username}`;
    this.dir = null;
    this.hasCommit = false;
    this.busy = false;
    this.pending = null;
    this.failures = 0;
    if (!this.enabled) log('Publish snapshot live nonaktif (GITHUB_TOKEN/GITHUB_REPOSITORY tidak ada).');
  }

  git(...args) {
    return execFileP('git', args, { cwd: this.dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  }

  async init() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-branch-'));
    const host = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/^https?:\/\//, '');
    await this.git('init', '-q');
    await this.git('config', 'user.name', 'github-actions[bot]');
    await this.git('config', 'user.email', '41898283+github-actions[bot]@users.noreply.github.com');
    await this.git('remote', 'add', 'origin', process.env.LIVE_REMOTE_URL || `https://x-access-token:${GH_TOKEN}@${host}/${GH_REPO}.git`);
    await this.git('checkout', '-q', '--orphan', this.branch);
  }

  async publish(snapshot) {
    if (!this.enabled) return;
    if (this.busy) { this.pending = snapshot; return; }
    this.busy = true;
    try {
      if (!this.dir) await this.init();
      fs.writeFileSync(path.join(this.dir, 'data.json'), JSON.stringify(snapshot));
      await this.git('add', 'data.json');
      await this.git('commit', '-q', ...(this.hasCommit ? ['--amend'] : []), '-m', `live ${snapshot.username} ${snapshot.updated_at}`);
      this.hasCommit = true;
      await this.git('push', '-q', '-f', 'origin', `HEAD:refs/heads/${this.branch}`);
      this.failures = 0;
    } catch (e) {
      this.failures += 1;
      if (this.failures <= 3 || this.failures % 20 === 0) {
        const msg = `${e.stderr || ''} ${errMsg(e)}`.split(GH_TOKEN || '\u0000').join('***').trim();
        warn(`Push snapshot gagal (${this.failures}x): ${msg.slice(0, 300)}`);
      }
    } finally {
      this.busy = false;
    }
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      await this.publish(next);
    }
  }

  async flush(timeoutMs = 30_000) {
    const start = Date.now();
    while ((this.busy || this.pending) && Date.now() - start < timeoutMs) await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// Koneksi TikTok
// ---------------------------------------------------------------------------
function isOfflineError(err) {
  if (UserOfflineError && err instanceof UserOfflineError) return true;
  const name = `${err?.name || ''} ${err?.constructor?.name || ''}`;
  const msg = errMsg(err);
  return /UserOffline/i.test(name) ||
    /offline|isn'?t online|not (currently )?live|live has ended|is not streaming|status 4|room.*(ended|closed)|no.*room.?id/i.test(msg);
}

function extractRoomMeta(roomInfo) {
  const ri = roomInfo?.data ?? roomInfo ?? {};
  const createRaw = pick(ri, ['create_time', 'createTime', 'room.create_time', 'data.create_time', 'liveRoom.startTime', 'start_time']);
  let liveStartedAt = null;
  if (createRaw) {
    const n = Number(createRaw);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    const age = Date.now() - d.getTime();
    // sanity check: tidak di masa depan dan tidak lebih dari 24 jam
    if (Number.isFinite(age) && age >= -60_000 && age < 24 * 3600 * 1000) liveStartedAt = d.toISOString();
  }
  return {
    title: String(pick(ri, ['title', 'room.title', 'liveRoom.title']) || ''),
    liveStartedAt,
    viewers: num(pick(ri, ['user_count', 'stats.user_count', 'liveRoomUserInfo.liveRoom.liveRoomStats.userCount', 'room.user_count'])),
    likes: num(pick(ri, ['like_count', 'stats.like_count', 'room.like_count']))
  };
}

function createConnection(username) {
  const options = {
    processInitialData: false,
    enableExtendedGiftInfo: false,
    fetchRoomInfoOnConnect: true
  };
  if (process.env.EULER_API_KEY) {
    options.signApiKey = process.env.EULER_API_KEY;
    if (SignConfig) SignConfig.apiKey = process.env.EULER_API_KEY;
  }
  if (process.env.TT_CONNECT_WITH_UNIQUE_ID === 'true') options.connectWithUniqueId = true;
  return new TikTokLiveConnection(username, options);
}

async function connectWithRetry(conn, attempts = CONNECT_ATTEMPTS) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const state = await conn.connect();
      return { state };
    } catch (err) {
      if (isOfflineError(err)) return { offline: true, err };
      warn(`Gagal konek (percobaan ${i}/${attempts}): ${errMsg(err)}`);
      if (i < attempts) await sleep(5000 * i);
      else return { failed: true, err };
    }
  }
  return { failed: true };
}

// ---------------------------------------------------------------------------
// Tracking utama
// ---------------------------------------------------------------------------
async function track(username) {
  const stamp = process.env.SESSION_STAMP || stampWIB(new Date());
  const releaseTag = process.env.RELEASE_TAG || `live-${username}-${stamp.replace('_', '-')}`;
  const publisher = new LiveBranchPublisher(username);

  const conn = createConnection(username);
  log(`Menghubungkan ke live @${username} ...`);
  const result = await connectWithRetry(conn);

  if (result.offline) {
    log(`Akun @${username} sedang offline / tidak live. Exit graceful.`);
    return { status: 'offline' };
  }
  if (result.failed) {
    warn(`Tidak bisa terhubung ke live @${username}: ${errMsg(result.err)}`);
    warn('Kemungkinan: akun offline, IP runner diblok/captcha, atau rate limit sign server. Exit graceful.');
    return { status: 'connect_failed' };
  }

  const meta = extractRoomMeta(result.state?.roomInfo ?? conn.roomInfo);
  const S = {
    username,
    roomId: String(result.state?.roomId ?? conn.roomId ?? ''),
    title: meta.title,
    liveStartedAt: meta.liveStartedAt,
    trackingStartedAt: new Date(),
    currentViewers: meta.viewers,
    peakViewers: meta.viewers,
    peakAt: meta.viewers ? new Date().toISOString() : null,
    totalLikesReported: meta.likes,
    likesAccum: 0,
    follows: 0,
    shares: 0,
    chats: [],
    commenters: new Map(),
    timeline: [],
    lastEventAt: Date.now(),
    endReason: null
  };
  log(`Terhubung. Room ${S.roomId} | judul: "${S.title}" | mulai live: ${fmtWIB(S.liveStartedAt) || 'tidak diketahui'}`);

  let resolveEnd;
  const ended = new Promise((r) => { resolveEnd = r; });
  const finish = (reason) => {
    if (S.endReason) return;
    S.endReason = reason;
    log(`Sesi berakhir: ${END_REASON_LABEL[reason] || reason}`);
    resolveEnd();
  };

  const touch = () => { S.lastEventAt = Date.now(); };
  const totalLikes = () => Math.max(S.totalLikesReported, S.likesAccum);
  const durationSec = (end = new Date()) => {
    const start = new Date(S.liveStartedAt || S.trackingStartedAt);
    return Math.max(0, Math.round((end - start) / 1000));
  };
  const setViewers = (v) => {
    if (!Number.isFinite(v) || v < 0) return;
    S.currentViewers = v;
    if (v > S.peakViewers) { S.peakViewers = v; S.peakAt = new Date().toISOString(); }
  };

  // ---- Event handler ----
  conn.on(WebcastEvent.ROOM_USER, (data) => {
    touch();
    setViewers(num(data?.viewerCount ?? data?.viewer_count ?? data?.total));
  });

  conn.on(WebcastEvent.LIKE, (data) => {
    touch();
    S.totalLikesReported = Math.max(S.totalLikesReported, num(data?.totalLikeCount ?? data?.total));
    S.likesAccum += num(data?.likeCount ?? data?.count);
  });

  conn.on(WebcastEvent.CHAT, (data) => {
    touch();
    const user = data?.user?.uniqueId ?? data?.uniqueId ?? 'unknown';
    const nickname = data?.user?.nickname ?? data?.nickname ?? '';
    const comment = String(data?.comment ?? '').trim();
    if (!comment) return;
    S.chats.push({ time: new Date().toISOString(), user, nickname, comment });
    const c = S.commenters.get(user) || { user, nickname, count: 0 };
    c.count += 1;
    if (nickname) c.nickname = nickname;
    S.commenters.set(user, c);
  });

  if (WebcastEvent.FOLLOW) conn.on(WebcastEvent.FOLLOW, () => { touch(); S.follows += 1; });
  if (WebcastEvent.SHARE) conn.on(WebcastEvent.SHARE, () => { touch(); S.shares += 1; });

  conn.on(STREAM_END_EVENT, () => finish('stream_end'));
  // payload error v2: { info, exception }
  conn.on(ControlEvent.ERROR, (e) => warn(`Error koneksi${e?.info ? ` (${e.info})` : ''}: ${errMsg(e?.exception ?? e)}`));

  let reconnecting = false;
  conn.on(ControlEvent.DISCONNECTED, async () => {
    if (S.endReason || reconnecting) return;
    reconnecting = true;
    warn('Koneksi terputus. Mencoba reconnect ...');
    for (let i = 1; i <= RECONNECT_ATTEMPTS && !S.endReason; i++) {
      await sleep(10_000 * i);
      if (S.endReason) break;
      try {
        await conn.connect();
        log(`Reconnect berhasil (percobaan ${i}).`);
        reconnecting = false;
        return;
      } catch (err) {
        if (isOfflineError(err)) { finish('stream_end'); break; }
        warn(`Reconnect gagal (${i}/${RECONNECT_ATTEMPTS}): ${errMsg(err)}`);
      }
    }
    reconnecting = false;
    finish('disconnected');
  });

  // ---- Snapshot & sampling ----
  const buildSnapshot = (status) => ({
    username,
    status,
    room_id: S.roomId,
    title: S.title,
    live_started_at: S.liveStartedAt,
    tracking_started_at: S.trackingStartedAt.toISOString(),
    updated_at: new Date().toISOString(),
    duration_sec: durationSec(),
    current_viewers: status === 'online' ? S.currentViewers : 0,
    peak_viewers: S.peakViewers,
    total_likes: totalLikes(),
    total_comments: S.chats.length,
    unique_commenters: S.commenters.size,
    follows: S.follows,
    shares: S.shares,
    snapshot_interval_sec: SNAPSHOT_INTERVAL_MS / 1000,
    release_tag: releaseTag,
    end_reason: S.endReason,
    timeline: S.timeline.slice(-180),
    recent_chats: S.chats.slice(-SNAPSHOT_CHAT_LIMIT)
  });

  const sample = () => {
    S.timeline.push({ t: new Date().toISOString(), v: S.currentViewers });
  };
  sample();
  publisher.publish(buildSnapshot('online'));

  const sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS);
  const snapshotTimer = setInterval(() => {
    log(`viewers=${S.currentViewers} peak=${S.peakViewers} likes=${totalLikes()} chat=${S.chats.length} durasi=${fmtDuration(durationSec())}`);
    publisher.publish(buildSnapshot('online'));
  }, SNAPSHOT_INTERVAL_MS);

  // Watchdog: kalau 5 menit tidak ada event sama sekali, cek apakah live masih jalan.
  const idleTimer = setInterval(async () => {
    if (S.endReason || reconnecting) return;
    if (Date.now() - S.lastEventAt < IDLE_CHECK_MS) return;
    try {
      const live = typeof conn.fetchIsLive === 'function' ? await conn.fetchIsLive() : true;
      if (!live) finish('idle_offline');
      else touch();
    } catch (e) {
      warn(`Cek status live gagal: ${errMsg(e)}`);
    }
  }, 60_000);

  const maxTimer = setTimeout(() => finish('max_duration'), MAX_LIVE_MINUTES * 60_000);
  const onSignal = () => finish('signal');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await ended;

  clearInterval(sampleTimer);
  clearInterval(snapshotTimer);
  clearInterval(idleTimer);
  clearTimeout(maxTimer);
  try { conn.disconnect(); } catch { /* abaikan */ }

  sample();
  const endedAt = new Date();
  const viewerSamples = S.timeline.map((p) => p.v).filter((v) => v > 0);
  const avgViewers = viewerSamples.length
    ? Math.round(viewerSamples.reduce((a, b) => a + b, 0) / viewerSamples.length)
    : 0;

  const session = {
    id: `${username}_${stamp}`,
    username,
    room_id: S.roomId,
    title: S.title,
    live_started_at: S.liveStartedAt,
    tracking_started_at: S.trackingStartedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_sec: durationSec(endedAt),
    tracked_duration_sec: Math.round((endedAt - S.trackingStartedAt) / 1000),
    end_reason: S.endReason,
    peak_viewers: S.peakViewers,
    peak_viewers_at: S.peakAt,
    avg_viewers: avgViewers,
    total_likes: totalLikes(),
    total_comments: S.chats.length,
    unique_commenters: S.commenters.size,
    follows: S.follows,
    shares: S.shares,
    viewer_timeline: S.timeline,
    top_commenters: topCommenters(S.commenters),
    top_keywords: extractKeywords(S.chats),
    session_report: `Session_${username}_${stamp}.xlsx`,
    release_tag: releaseTag
  };

  // ---- Simpan histori (90 hari) & Excel ----
  const history = loadHistory(username);
  const before = history.sessions.length;
  history.sessions = pruneSessions([...history.sessions.filter((s) => s.id !== session.id), session]);
  const removed = before + 1 - history.sessions.length;
  saveHistory(history);
  log(`Histori disimpan: ${history.sessions.length} sesi (${removed > 0 ? removed + ' sesi >' + RETENTION_DAYS + ' hari dihapus' : 'tidak ada yang dihapus'}).`);

  const sessionFile = path.join(OUT_DIR, session.session_report);
  const reportFile = path.join(OUT_DIR, `Report_${username}_3_Months.xlsx`);
  await buildSessionReport(session, S.chats, sessionFile);
  await buildThreeMonthReport(history, reportFile);
  fs.writeFileSync(path.join(OUT_DIR, 'session.json'), JSON.stringify({
    ...session, viewer_timeline: undefined, chat_count: S.chats.length
  }, null, 2));
  log(`Excel dibuat: ${path.relative(ROOT, sessionFile)}, ${path.relative(ROOT, reportFile)}`);

  await publisher.flush();
  await publisher.publish({ ...buildSnapshot('offline'), last_session_id: session.id });
  await publisher.flush();

  return { status: 'tracked', session };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const config = readConfig();
  const firstAccount = Array.isArray(config.accounts) ? config.accounts[0] : config.target_username;
  const username = normalizeUsername(process.argv[2] || firstAccount);

  if (!username || username === 'username_target') {
    warn('Username belum diberikan (argumen atau data/config.json). Exit.');
    return 0;
  }
  if (!USERNAME_RE.test(username)) {
    warn(`Username "${username}" tidak valid (huruf kecil, angka, titik, underscore; 2-24 karakter). Exit.`);
    return 0;
  }
  if (!TikTokLiveConnection || !WebcastEvent || !ControlEvent) {
    console.error('tiktok-live-connector v2 tidak ditemukan / API berubah. Jalankan: npm install tiktok-live-connector@^2');
    return 1;
  }

  const res = await track(username);
  log(`Selesai dengan status: ${res.status}`);
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[tracker] ERROR tak terduga:', err);
      process.exit(1);
    });
}
