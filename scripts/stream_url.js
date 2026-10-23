#!/usr/bin/env node
/**
 * Ambil URL stream video live (FLV / HLS) langsung dari data room TikTok,
 * dipakai recorder sebagai jalur cadangan kalau Streamlink gagal.
 *
 * Pemakaian : node scripts/stream_url.js <username>
 * Output    : 1 baris URL terbaik (stdout). Exit 0 kalau ketemu, 2 kalau tidak.
 */
import * as TTL from 'tiktok-live-connector';

const username = String(process.argv[2] || '').replace(/^@/, '').toLowerCase();
if (!username) { console.error('Pemakaian: node scripts/stream_url.js <username>'); process.exit(1); }

const TIMEOUT_MS = 30_000;
const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);

/** Kumpulkan semua string URL .flv / .m3u8, termasuk yang ada di dalam string JSON bersarang. */
function collectUrls(node, out, depth = 0) {
  if (depth > 12 || node == null) return;
  if (typeof node === 'string') {
    const s = node.trim();
    if ((s.startsWith('{') || s.startsWith('[')) && s.length < 200_000) {
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

try {
  const opts = process.env.EULER_API_KEY ? { signApiKey: process.env.EULER_API_KEY } : {};
  const conn = new TTL.TikTokLiveConnection(username, opts);
  const info = await withTimeout(conn.fetchRoomInfo());
  const urls = new Set();
  collectUrls(info, urls);
  const best = [...urls].sort((a, b) => score(b) - score(a))[0];
  if (!best) {
    console.error(`Tidak menemukan URL stream untuk @${username} (akun offline atau format data berubah).`);
    process.exit(2);
  }
  console.error(`Ditemukan ${urls.size} URL stream, pakai yang skornya tertinggi.`);
  console.log(best);
  process.exit(0);
} catch (e) {
  console.error(`Gagal mengambil data room @${username}: ${e?.message || e}`);
  process.exit(2);
}
