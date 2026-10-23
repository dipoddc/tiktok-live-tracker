#!/usr/bin/env node
/**
 * Ambil URL stream video live (FLV / HLS) dari beberapa sumber data TikTok,
 * dipakai recorder sebagai jalur cadangan kalau Streamlink gagal.
 *
 * Sumber yang dicoba berurutan (berhenti di sumber pertama yang punya URL):
 *   1. api-live/user/room   (API web TikTok)
 *   2. halaman @user/live    (SIGI_STATE di HTML)
 *   3. webcast room/info     (API webcast)
 *   4. Euler Stream          (sign server pihak ketiga)
 *
 * Pemakaian : node scripts/stream_url.js <username>
 * Output    : stdout = 1 baris URL terbaik. Diagnostik per sumber ke stderr.
 *             Exit 0 kalau ketemu, 2 kalau tidak.
 */
import * as TTL from 'tiktok-live-connector';

const username = String(process.argv[2] || '').replace(/^@/, '').toLowerCase();
if (!username) { console.error('Pemakaian: node scripts/stream_url.js <username>'); process.exit(1); }

const TIMEOUT_MS = 25_000;
const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
const say = (m) => console.error(`[stream_url @${username}] ${m}`);

/** Kumpulkan semua URL .flv / .m3u8, termasuk di dalam string JSON bersarang (stream_data). */
function collectUrls(node, out, depth = 0) {
  if (depth > 14 || node == null) return;
  if (typeof node === 'string') {
    const s = node.trim();
    if ((s.startsWith('{') || s.startsWith('[')) && s.length < 500_000) {
      try { collectUrls(JSON.parse(s), out, depth + 1); } catch { /* bukan JSON */ }
      return;
    }
    if (/^https?:\/\/\S+\.(flv|m3u8)(\?|$)/i.test(s)) out.add(s);
    return;
  }
  if (Array.isArray(node)) { node.forEach((v) => collectUrls(v, out, depth + 1)); return; }
  if (typeof node === 'object') Object.values(node).forEach((v) => collectUrls(v, out, depth + 1));
}

function score(url) {
  const u = url.toLowerCase();
  let s = 0;
  if (u.includes('.flv')) s += 10;              // FLV lebih stabil untuk direkam
  if (/origin|_or4|fullhd|full_hd|uhd/.test(u)) s += 5;
  else if (/_hd|hd1|hd\./.test(u)) s += 3;
  else if (/_sd|sd1|sd\./.test(u)) s += 1;
  if (/_ld|ld1|ld\./.test(u)) s -= 2;
  return s;
}

/** Ringkas status room dari data mentah, untuk diagnosis (2 = live, 4 = selesai). */
function roomStatus(data) {
  const seen = [];
  const walk = (n, d = 0) => {
    if (!n || typeof n !== 'object' || d > 6) return;
    if (typeof n.status === 'number' && seen.length < 3) seen.push(n.status);
    Object.values(n).forEach((v) => walk(v, d + 1));
  };
  walk(data);
  return seen.length ? seen.join('/') : '?';
}

const opts = process.env.EULER_API_KEY ? { signApiKey: process.env.EULER_API_KEY } : {};
const conn = new TTL.TikTokLiveConnection(username, opts);
const R = TTL.RouteConfig || {};

const sources = [
  ['api-live', () => R.fetchRoomInfoFromApiLive({ webClient: conn.webClient, uniqueId: username })],
  ['html', () => R.fetchRoomInfoFromHtml({ webClient: conn.webClient, uniqueId: username })],
  ['room-info', () => conn.fetchRoomInfo()],
  ['euler', () => R.fetchRoomInfoFromProvider({ apiClient: conn.apiClient, uniqueId: username })]
];

for (const [name, fn] of sources) {
  try {
    if (typeof fn !== 'function') continue;
    const data = await withTimeout(fn());
    const urls = new Set();
    collectUrls(data, urls);
    say(`sumber ${name}: OK, status room=${roomStatus(data)}, URL stream ditemukan=${urls.size}`);
    if (urls.size) {
      const best = [...urls].sort((a, b) => score(b) - score(a))[0];
      say(`pakai URL dari sumber ${name}`);
      console.log(best);
      process.exit(0);
    }
  } catch (e) {
    say(`sumber ${name}: gagal (${String(e?.message || e).slice(0, 160)})`);
  }
}

say('tidak ada sumber yang memberikan URL stream. Kemungkinan: akun offline, live dibatasi (umur/region/subscriber), atau TikTok menyembunyikan stream dari IP server.');
process.exit(2);
