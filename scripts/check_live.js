#!/usr/bin/env node
/**
 * Cek cadangan status live pakai TikTok-Live-Connector.
 * Pemakaian : node scripts/check_live.js user1 user2 ...
 * Output    : 1 baris JSON, mis. {"user1":"live","user2":"offline","user3":"error:..."}
 */
import * as TTL from 'tiktok-live-connector';

const TIMEOUT_MS = 25_000;
const users = process.argv.slice(2).map((u) => u.replace(/^@/, '').toLowerCase()).filter(Boolean);
const out = {};

const withTimeout = (p) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))
]);

for (const u of users) {
  try {
    const opts = process.env.EULER_API_KEY ? { signApiKey: process.env.EULER_API_KEY } : {};
    const conn = new TTL.TikTokLiveConnection(u, opts);
    const live = await withTimeout(conn.fetchIsLive());
    out[u] = live ? 'live' : 'offline';
  } catch (e) {
    out[u] = `error:${String(e?.message || e).slice(0, 120)}`;
  }
}

console.log(JSON.stringify(out));
process.exit(0);
