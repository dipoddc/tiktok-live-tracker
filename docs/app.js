/* TikTok Live Tracker v2 - Dashboard (GitHub Pages)
 *
 * Sumber data:
 *   data/config.json                         (branch default)   -> daftar akun, record_target, auto record
 *   status.json                              (branch live-status) -> ON/OFF semua akun (detector)
 *   data.json                                (branch live-<user>) -> angka live + chat (tracker, tiap ±15 dtk)
 *   data/history/<user>_history.json         (branch default)   -> histori 90 hari
 *   GitHub Releases                          -> Excel & video
 */
'use strict';

const API = 'https://api.github.com';
const TZ = 'Asia/Jakarta';
const STATUS_BRANCH = 'live-status';
const LIVE_PREFIX = 'live-';
const DETECTOR_WORKFLOW = 'monitor_live.yml';
const MAX_ACCOUNTS = 10;
const USERNAME_RE = /^[a-z0-9._]{2,24}$/;
const CHAT_KEEP = 500;
const LS = { token: 'tlt.pat', owner: 'tlt.owner', repo: 'tlt.repo', tab: 'tlt.tab', onlySel: 'tlt.onlySelected' };

const $ = (id) => document.getElementById(id);

const S = {
  owner: '', repo: '', token: '', defaultBranch: null,
  config: { accounts: [], record_target: '', auto_record_enabled: true },
  status: null,
  live: {},          // user -> snapshot
  chats: {},         // user -> { list: [], keys: Set }
  selected: null,    // akun di panel detail
  histAccount: null,
  history: {},       // user -> { sessions }
  releases: [],
  trendChart: null,
  miniChart: null,
  pollTimer: null,
  tickTimer: null,
  busy: false
};

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) {
  try { if (v === null || v === undefined || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* mode privat */ }
}
const nf = new Intl.NumberFormat('id-ID');
const fmtNum = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '-' : nf.format(Number(n)));
function fmtWIB(iso, sec = false) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}), hour12: false }).format(d);
}
function fmtTimeWIB(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso));
}
function fmtDateShort(iso) { return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: 'short' }).format(new Date(iso)); }
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function fmtAgo(iso) {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}
function fmtBytes(b) {
  if (!b && b !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const normU = (v) => String(v || '').trim().replace(/^@+/, '').toLowerCase().replace(/\s+/g, '');
const sessionStart = (s) => s.live_started_at || s.tracking_started_at || s.ended_at;
const ageMs = (iso) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64DecodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

let toastTimer = null;
function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'fixed bottom-4 right-4 max-w-sm rounded-xl px-4 py-3 text-sm shadow-lg z-50 ' +
    (type === 'error' ? 'bg-rose-600 text-white' : type === 'ok' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-100');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------
class GhError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function gh(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch { /* abaikan */ }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') msg = 'Rate limit GitHub API habis. Isi PAT di Pengaturan.';
    throw new GhError(res.status, msg);
  }
  if (res.status === 204) return null;
  return accept.includes('raw') ? res.text() : res.json();
}
const repoPath = () => `/repos/${encodeURIComponent(S.owner)}/${encodeURIComponent(S.repo)}`;
async function ensureDefaultBranch() {
  if (S.defaultBranch) return S.defaultBranch;
  try { S.defaultBranch = (await gh(repoPath())).default_branch || 'main'; } catch { S.defaultBranch = 'main'; }
  return S.defaultBranch;
}
async function readRaw(path, ref) {
  return gh(`${repoPath()}/contents/${path}?ref=${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.raw+json' });
}
async function readJsonOrNull(path, ref) {
  try { return JSON.parse(await readRaw(path, ref)); } catch (e) { if (e.status && e.status !== 404) console.warn(path, ref, e.message); return null; }
}

// ---------------------------------------------------------------------------
// Pengaturan
// ---------------------------------------------------------------------------
function detectRepoFromUrl() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return {};
  const owner = host.replace(/\.github\.io$/, '');
  const first = location.pathname.split('/').filter(Boolean)[0];
  return { owner, repo: first || `${owner}.github.io` };
}
function loadSettings() {
  const d = detectRepoFromUrl();
  S.owner = lsGet(LS.owner) || d.owner || '';
  S.repo = lsGet(LS.repo) || d.repo || '';
  S.token = lsGet(LS.token) || '';
  $('inOwner').value = S.owner;
  $('inRepo').value = S.repo;
  $('inToken').value = S.token ? '••••••••••••' : '';
  $('inOnlySelected').checked = lsGet(LS.onlySel) !== 'false';
  updateRepoLabel();
  if (!S.owner || !S.repo || !S.token) $('settingsPanel').classList.remove('hidden');
}
function updateRepoLabel() {
  $('repoLabel').textContent = S.owner && S.repo
    ? `${S.owner}/${S.repo} · ${S.token ? 'token tersimpan' : 'tanpa token (read-only, update tiap 2 menit)'}`
    : 'Repo belum diatur, buka Pengaturan';
}
async function saveSettings() {
  const owner = $('inOwner').value.trim(), repo = $('inRepo').value.trim(), tok = $('inToken').value.trim();
  if (!owner || !repo) { $('settingsMsg').textContent = 'Owner & repository wajib diisi.'; return; }
  S.owner = owner; S.repo = repo; S.defaultBranch = null;
  if (tok && !tok.startsWith('•')) S.token = tok;
  lsSet(LS.owner, owner); lsSet(LS.repo, repo); lsSet(LS.token, S.token);
  $('inToken').value = S.token ? '••••••••••••' : '';
  $('settingsMsg').textContent = 'Mengetes koneksi...';
  try {
    const info = await gh(repoPath());
    S.defaultBranch = info.default_branch;
    $('settingsMsg').textContent = S.token
      ? (info.permissions?.push ? 'Terhubung, token punya akses tulis.' : 'Terhubung, tapi token TIDAK punya akses tulis.')
      : 'Terhubung tanpa token (read-only).';
    updateRepoLabel();
    await refreshAll();
  } catch (e) { $('settingsMsg').textContent = `Gagal: ${e.message}`; }
}
function clearToken() {
  S.token = ''; lsSet(LS.token, null); $('inToken').value = '';
  updateRepoLabel(); restartPolling(); toast('Token dihapus dari browser ini.');
}
async function runDetector() {
  if (!S.token) return toast('Isi PAT dulu di Pengaturan.', 'error');
  try {
    await gh(`${repoPath()}/actions/workflows/${DETECTOR_WORKFLOW}/dispatches`, { method: 'POST', body: { ref: await ensureDefaultBranch() } });
    toast('Detector dipicu. Kalau detector lama masih jalan, yang baru antre di belakangnya.', 'ok');
  } catch (e) {
    let msg = `Gagal memicu detector: ${e.message}`;
    if (e.status === 404 || e.status === 403) {
      let exists = true;
      try { await gh(`${repoPath()}/actions/workflows/${DETECTOR_WORKFLOW}`); } catch (e2) { if (e2.status === 404) exists = false; }
      msg = exists ? 'Gagal memicu detector. Pastikan PAT punya izin "Actions: Read and write".'
        : `File .github/workflows/${DETECTOR_WORKFLOW} tidak ditemukan di repo.`;
    }
    toast(msg, 'error');
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function normalizeConfig(raw) {
  const list = [...(Array.isArray(raw?.accounts) ? raw.accounts : []), ...(raw?.target_username ? [raw.target_username] : [])]
    .map(normU).filter((u) => USERNAME_RE.test(u) && u !== 'username_target');
  const accounts = [...new Set(list)].slice(0, MAX_ACCOUNTS);
  const rt = normU(raw?.record_target);
  return {
    accounts,
    record_target: accounts.includes(rt) ? rt : '',
    auto_record_enabled: raw?.auto_record_enabled !== false
  };
}
async function loadConfig() {
  const branch = await ensureDefaultBranch();
  const file = await gh(`${repoPath()}/contents/data/config.json?ref=${encodeURIComponent(branch)}`);
  S.config = normalizeConfig(JSON.parse(b64DecodeUtf8(file.content)));
}
/** Baca config terbaru, ubah lewat mutator, simpan. Mengembalikan true kalau berhasil. */
async function updateConfig(mutator, message) {
  if (!S.token) { toast('Isi Personal Access Token dulu di Pengaturan.', 'error'); return false; }
  if (S.busy) { toast('Masih menyimpan perubahan sebelumnya, tunggu sebentar.'); return false; }
  S.busy = true;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const branch = await ensureDefaultBranch();
      const latest = await gh(`${repoPath()}/contents/data/config.json?ref=${encodeURIComponent(branch)}`);
      const cfg = normalizeConfig(JSON.parse(b64DecodeUtf8(latest.content)));
      const err = mutator(cfg);
      if (err) { toast(err, 'error'); return false; }
      try {
        await gh(`${repoPath()}/contents/data/config.json`, {
          method: 'PUT',
          body: { message: `chore(config): ${message} (dashboard)`, content: b64EncodeUtf8(JSON.stringify(cfg, null, 2) + '\n'), sha: latest.sha, branch }
        });
        S.config = cfg;
        return true;
      } catch (e) {
        if (e.status === 409 && attempt === 1) continue; // config berubah di tengah jalan, ulangi
        throw e;
      }
    }
    return false;
  } catch (e) {
    toast(`Gagal menyimpan config: ${e.message}`, 'error');
    return false;
  } finally {
    S.busy = false;
  }
}

async function addAccount() {
  const u = normU($('inNewAccount').value);
  $('accountMsg').textContent = '';
  if (!USERNAME_RE.test(u)) { $('accountMsg').textContent = 'Username tidak valid (huruf kecil, angka, titik, underscore; 2-24 karakter).'; return; }
  const ok = await updateConfig((cfg) => {
    if (cfg.accounts.includes(u)) return `@${u} sudah ada di daftar.`;
    if (cfg.accounts.length >= MAX_ACCOUNTS) return `Maksimal ${MAX_ACCOUNTS} akun. Hapus salah satu dulu.`;
    cfg.accounts.push(u);
    return null;
  }, `tambah @${u}`);
  if (ok) {
    $('inNewAccount').value = '';
    toast(`@${u} ditambahkan. Status live muncul setelah putaran cek detector berikutnya (±1,5 menit).`, 'ok');
    renderAll();
  }
}
async function removeAccount(u) {
  if (!confirm(`Hapus @${u} dari My TikTokers? Histori & file lama tidak ikut terhapus.`)) return;
  const ok = await updateConfig((cfg) => {
    cfg.accounts = cfg.accounts.filter((x) => x !== u);
    if (cfg.record_target === u) cfg.record_target = '';
    return null;
  }, `hapus @${u}`);
  if (ok) {
    if (S.selected === u) closeDetail();
    toast(`@${u} dihapus.`, 'ok');
    renderAll();
  }
}
async function setRecordTarget(u) {
  const ok = await updateConfig((cfg) => {
    if (u && !cfg.accounts.includes(u)) return `@${u} tidak ada di daftar akun.`;
    cfg.record_target = u || '';
    return null;
  }, u ? `record target @${u}` : 'record target dikosongkan');
  if (ok) {
    toast(u ? `Auto record diarahkan ke @${u}. Mulai merekam saat terdeteksi live.` : 'Tidak ada akun yang direkam.', 'ok');
    renderAll();
  } else {
    renderRecord();
  }
}
async function setAutoRecord(on) {
  const ok = await updateConfig((cfg) => { cfg.auto_record_enabled = on; return null; }, `auto record ${on ? 'ON' : 'OFF'}`);
  if (ok) toast(`Auto record ${on ? 'diaktifkan' : 'dimatikan'}.`, 'ok');
  renderRecord();
}

// ---------------------------------------------------------------------------
// Status & data live
// ---------------------------------------------------------------------------
function statusOf(u) { return S.status?.accounts?.[u] || null; }
function snapFresh(snap) {
  if (!snap || snap.status !== 'online') return false;
  const iv = (Number(snap.snapshot_interval_sec) || 15) * 1000;
  return ageMs(snap.updated_at) < Math.max(90_000, iv * 6);
}
/** live | offline | error | pending */
function stateOf(u) {
  const st = statusOf(u), snap = S.live[u];
  if (snapFresh(snap)) return 'live';
  if (!st) return 'pending';
  if (st.live) return 'live';
  if (st.state === 'error') return 'error';
  return 'offline';
}
function liveDurationSec(snap) {
  const start = snap.live_started_at || snap.tracking_started_at;
  return start ? (Date.now() - new Date(start).getTime()) / 1000 : Number(snap.duration_sec) || 0;
}

async function loadStatus() {
  S.status = await readJsonOrNull('status.json', STATUS_BRANCH);
}
async function loadLive(u) {
  const snap = await readJsonOrNull('data.json', `${LIVE_PREFIX}${u}`);
  if (!snap) return;
  S.live[u] = snap;
  const store = S.chats[u] || (S.chats[u] = { list: [], keys: new Set(), sessionTag: null });
  if (store.sessionTag !== snap.release_tag) { store.list = []; store.keys = new Set(); store.sessionTag = snap.release_tag; }
  for (const c of snap.recent_chats || []) {
    const k = `${c.time}|${c.user}|${c.comment}`;
    if (store.keys.has(k)) continue;
    store.keys.add(k);
    store.list.push(c);
  }
  if (store.list.length > CHAT_KEEP) {
    const drop = store.list.splice(0, store.list.length - CHAT_KEEP);
    drop.forEach((c) => store.keys.delete(`${c.time}|${c.user}|${c.comment}`));
  }
}
async function pollLive() {
  if (!S.owner || !S.repo) return;
  await loadStatus();
  const targets = S.config.accounts.filter((u) => {
    const st = statusOf(u);
    return st?.live || st?.tracking || snapFresh(S.live[u]) || u === S.selected;
  });
  await Promise.all(targets.map(loadLive));
  renderAll();
}

// ---------------------------------------------------------------------------
// Render: header & peringatan
// ---------------------------------------------------------------------------
function renderHeader() {
  const total = S.config.accounts.length;
  const liveCount = S.config.accounts.filter((u) => stateOf(u) === 'live').length;
  const pill = $('liveSummary');
  pill.replaceChildren();
  if (liveCount > 0) {
    pill.className = 'ml-1 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold bg-rose-600 text-white';
    pill.append(el('span', 'w-2 h-2 rounded-full bg-white pulse-dot'), document.createTextNode(`${liveCount} LIVE dari ${total}`));
  } else {
    pill.className = 'ml-1 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold bg-slate-800 text-slate-300';
    pill.append(el('span', 'w-2 h-2 rounded-full bg-slate-500'), document.createTextNode(total ? `Semua OFFLINE (${total} akun)` : 'Belum ada akun'));
  }

  const warn = $('detectorWarn');
  if (total && S.status) {
    const iv = (Number(S.status.sweep_interval_sec) || 90) * 1000;
    const limit = S.status.loop_mode ? Math.max(6 * 60_000, iv * 4) : 20 * 60_000;
    if (ageMs(S.status.updated_at) > limit) {
      warn.classList.remove('hidden');
      $('detectorWarnText').textContent = `Detector terakhir cek ${fmtAgo(S.status.updated_at)}. Status ON/OFF mungkin tidak akurat. Cek tab Actions atau klik "Jalankan Detector" di Pengaturan.`;
      return;
    }
  } else if (total && !S.status) {
    warn.classList.remove('hidden');
    $('detectorWarnText').textContent = 'Detector belum pernah berjalan. Klik "Jalankan Detector" di Pengaturan, atau tunggu jadwal otomatis.';
    return;
  }
  warn.classList.add('hidden');
}

function badge(state, small = false) {
  const base = `inline-flex items-center gap-1.5 rounded-full ${small ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'} font-bold`;
  const b = el('span');
  if (state === 'live') { b.className = `${base} bg-rose-600 text-white`; b.append(el('span', 'w-2 h-2 rounded-full bg-white pulse-dot'), document.createTextNode('LIVE')); }
  else if (state === 'error') { b.className = `${base} bg-amber-500/20 text-amber-300`; b.textContent = 'CEK GAGAL'; }
  else if (state === 'pending') { b.className = `${base} bg-slate-800 text-slate-400`; b.textContent = 'MENUNGGU CEK'; }
  else { b.className = `${base} bg-slate-800 text-slate-300`; b.append(el('span', 'w-2 h-2 rounded-full bg-slate-500'), document.createTextNode('OFFLINE')); }
  return b;
}

// ---------------------------------------------------------------------------
// Render: My TikTokers
// ---------------------------------------------------------------------------
function statBox(label, value) {
  const d = el('div', 'rounded-lg bg-slate-950/60 border border-slate-800 px-2.5 py-2');
  d.append(el('p', 'text-[11px] text-slate-400', label), el('p', 'text-lg font-semibold tabular-nums', value));
  return d;
}
function renderTiktokers() {
  const n = S.config.accounts.length;
  $('accountCount').textContent = `${n}/${MAX_ACCOUNTS}`;
  $('btnAddAccount').disabled = n >= MAX_ACCOUNTS;

  const grid = $('accountGrid');
  grid.replaceChildren();
  if (!n) {
    grid.append(el('p', 'text-sm text-slate-500 sm:col-span-2 lg:col-span-3', 'Belum ada akun. Tambahkan username TikTok di atas (maksimal 10).'));
    return;
  }
  // akun live di urutan atas
  const order = [...S.config.accounts].sort((a, b) => (stateOf(b) === 'live') - (stateOf(a) === 'live'));
  for (const u of order) {
    const state = stateOf(u), st = statusOf(u), snap = S.live[u];
    const card = el('div', `rounded-2xl border ${state === 'live' ? 'border-rose-600/60' : 'border-slate-800'} bg-slate-900/60 p-4 flex flex-col gap-3`);

    const head = el('div', 'flex items-center gap-2');
    head.append(el('p', 'font-semibold truncate', `@${u}`), badge(state, true));
    if (S.config.record_target === u && S.config.auto_record_enabled) {
      const rec = el('span', `rounded-full px-2 py-0.5 text-[11px] font-bold ${st?.recording ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-800 text-slate-400'}`, st?.recording ? '● REC' : 'REC siap');
      head.append(rec);
    }
    card.append(head);

    if (state === 'live') {
      if (snapFresh(snap)) {
        const g = el('div', 'grid grid-cols-3 gap-2');
        g.append(
          statBox('Viewers', fmtNum(snap.current_viewers)),
          statBox('Peak', fmtNum(snap.peak_viewers)),
          statBox('Durasi', fmtDuration(liveDurationSec(snap))),
          statBox('Likes', fmtNum(snap.total_likes)),
          statBox('Komentar', fmtNum(snap.total_comments)),
          statBox('Follow', fmtNum(snap.follows))
        );
        card.append(g);
        if (snap.title) card.append(el('p', 'text-xs text-slate-400 truncate', snap.title));
      } else {
        card.append(el('p', 'text-sm text-slate-400', st?.tracking ? 'Live terdeteksi, tracker sedang menyambung (±1-2 menit)...' : 'Live terdeteksi, menunggu tracker dimulai...'));
      }
    } else if (state === 'error') {
      card.append(el('p', 'text-xs text-amber-300 break-words', `Cek gagal: ${st?.error || 'tidak diketahui'}`));
    } else if (snap && snap.status === 'offline') {
      card.append(el('p', 'text-xs text-slate-400', `Live terakhir: ${fmtWIB(snap.live_started_at || snap.tracking_started_at)} · peak ${fmtNum(snap.peak_viewers)} · ${fmtDuration(snap.duration_sec)}`));
    }

    const foot = el('div', 'mt-auto flex items-center gap-2 text-xs text-slate-500');
    foot.append(el('span', '', st ? `dicek ${fmtAgo(st.checked_at)}` : 'belum dicek'));
    const btnView = el('button', 'ml-auto rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white', state === 'live' ? 'Lihat Live' : 'Detail');
    btnView.addEventListener('click', () => openDetail(u));
    const btnDel = el('button', 'rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-1.5 text-xs text-slate-300', 'Hapus');
    btnDel.addEventListener('click', () => removeAccount(u));
    foot.append(btnView, btnDel);
    card.append(foot);
    grid.append(card);
  }
}

async function openDetail(u) {
  S.selected = u;
  $('liveDetail').classList.remove('hidden');
  renderDetail();
  $('liveDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await loadLive(u);
  renderDetail();
}
function closeDetail() {
  S.selected = null;
  $('liveDetail').classList.add('hidden');
}

function renderDetail() {
  const u = S.selected;
  if (!u) return;
  if (!S.config.accounts.includes(u)) { closeDetail(); return; }
  const snap = S.live[u], state = stateOf(u), fresh = snapFresh(snap);
  $('dTitle').textContent = `@${u}`;
  $('dBadge').replaceChildren(badge(state));
  $('dLink').href = `https://www.tiktok.com/@${encodeURIComponent(u)}/live`;
  $('dLiveTitle').textContent = snap?.title ? `"${snap.title}"` : '';

  if (!snap) {
    ['dCurrent', 'dPeak', 'dDuration', 'dLikes', 'dComments', 'dSocial'].forEach((id) => { $(id).textContent = '-'; });
    $('dMeta').textContent = state === 'live' ? 'Menunggu data pertama dari tracker...' : 'Belum ada data live untuk akun ini.';
  } else {
    $('dCurrent').textContent = fresh ? fmtNum(snap.current_viewers) : '0';
    $('dPeak').textContent = fmtNum(snap.peak_viewers);
    $('dDuration').textContent = fmtDuration(fresh ? liveDurationSec(snap) : snap.duration_sec);
    $('dLikes').textContent = fmtNum(snap.total_likes);
    $('dComments').textContent = `${fmtNum(snap.total_comments)} / ${fmtNum(snap.unique_commenters)}`;
    $('dSocial').textContent = `${fmtNum(snap.follows)} / ${fmtNum(snap.shares)}`;
    $('dMeta').textContent = fresh
      ? `Data terakhir ${fmtAgo(snap.updated_at)} (${fmtTimeWIB(snap.updated_at)} WIB) · diperbarui tiap ±${snap.snapshot_interval_sec || 15} dtk.`
      : `Sesi terakhir: ${fmtWIB(snap.live_started_at || snap.tracking_started_at)} s/d ${fmtWIB(snap.updated_at)} WIB. Angka = hasil akhir sesi.`;
  }
  renderMiniChart(snap);
  renderDetailChat(u);
}

function renderMiniChart(snap) {
  if (typeof Chart === 'undefined') return;
  const pts = snap?.timeline || [];
  const labels = pts.map((p) => fmtTimeWIB(p.t).slice(0, 5));
  const data = pts.map((p) => Number(p.v) || 0);
  if (S.miniChart) {
    S.miniChart.data.labels = labels;
    S.miniChart.data.datasets[0].data = data;
    S.miniChart.update('none');
    return;
  }
  S.miniChart = new Chart($('miniChart'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Viewers', data, borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,.15)', fill: true, tension: 0.3, pointRadius: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8', maxTicksLimit: 8 }, grid: { color: 'rgba(148,163,184,.08)' } },
        y: { beginAtZero: true, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.08)' } }
      }
    }
  });
}

function renderDetailChat(u) {
  const box = $('dChat');
  const list = S.chats[u]?.list || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  if (!list.length) box.append(el('li', 'text-slate-500', 'Belum ada chat.'));
  for (const c of list.slice(-250)) {
    // textContent saja: isi chat dari publik, jangan pernah dirender sebagai HTML
    const li = el('li', 'leading-snug');
    const name = el('span', 'font-semibold text-indigo-300 mr-1.5', c.nickname || `@${c.user}`);
    name.title = `@${c.user}`;
    li.append(el('span', 'text-[11px] text-slate-500 mr-1.5 tabular-nums', fmtTimeWIB(c.time)), name, el('span', 'text-slate-200 break-words', c.comment));
    box.append(li);
  }
  $('dChatCount').textContent = `${list.length} komentar terkumpul di dashboard`;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// Render: Auto Record
// ---------------------------------------------------------------------------
function renderRecord() {
  const cfg = S.config;
  $('inAutoRecord').checked = cfg.auto_record_enabled;
  const rt = cfg.record_target;
  const st = rt ? statusOf(rt) : null;

  const box = $('recStatus');
  box.replaceChildren();
  if (!cfg.auto_record_enabled) {
    box.append(el('span', 'text-slate-400', 'Auto record dimatikan. Tidak ada akun yang direkam.'));
  } else if (!rt) {
    box.append(el('span', 'text-slate-400', 'Belum ada akun dipilih untuk direkam.'));
  } else if (st?.recording) {
    box.append(el('span', 'text-rose-300 font-semibold', `● Sedang merekam @${rt}`), el('span', 'text-slate-400', ` · video di-upload ke Releases setelah live selesai.`));
  } else if (stateOf(rt) === 'live') {
    box.append(el('span', 'text-amber-300', `@${rt} sedang live, recorder sedang dimulai (±1-2 menit)...`));
  } else {
    box.append(el('span', 'text-slate-300', `Siap merekam @${rt}. Rekaman mulai otomatis saat akun ini terdeteksi live.`));
  }

  const list = $('recList');
  list.replaceChildren();
  if (!cfg.accounts.length) {
    list.append(el('p', 'text-sm text-slate-500', 'Tambahkan akun dulu di tab My TikTokers.'));
  }
  const mkRow = (u, label) => {
    const row = el('label', `flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer ${rt === u ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 hover:bg-slate-800/50'}`);
    const radio = el('input');
    radio.type = 'radio'; radio.name = 'recTarget'; radio.value = u; radio.checked = rt === u;
    radio.disabled = !cfg.auto_record_enabled || S.busy;
    radio.addEventListener('change', () => setRecordTarget(u));
    row.append(radio, el('span', 'text-sm font-medium', label));
    if (u) row.append(badge(stateOf(u), true));
    return row;
  };
  for (const u of cfg.accounts) list.append(mkRow(u, `@${u}`));
  if (cfg.accounts.length) list.append(mkRow('', 'Tidak merekam akun apa pun'));

  // Daftar video
  const tbody = $('recFiles');
  tbody.replaceChildren();
  const vids = releaseAssets().filter((r) => r.kind === 'video');
  if (!vids.length) {
    const tr = el('tr'); const td = el('td', 'py-4 text-slate-500', 'Belum ada rekaman video.'); td.colSpan = 5; tr.append(td); tbody.append(tr);
  }
  for (const r of vids) {
    const tr = el('tr');
    tr.append(
      el('td', 'py-2 pr-4 font-medium break-all', r.asset.name),
      el('td', 'py-2 pr-4', `@${r.user}`),
      el('td', 'py-2 pr-4 text-right tabular-nums', fmtBytes(r.asset.size)),
      el('td', 'py-2 pr-4 whitespace-nowrap', fmtWIB(r.asset.updated_at)),
      downloadCell(r.asset)
    );
    tbody.append(tr);
  }
}

// ---------------------------------------------------------------------------
// Histori
// ---------------------------------------------------------------------------
function renderHistAccountSelect() {
  const sel = $('histAccount');
  const accounts = S.config.accounts;
  if (!S.histAccount || !accounts.includes(S.histAccount)) S.histAccount = accounts[0] || null;
  const current = [...sel.options].map((o) => o.value).join(',');
  if (current !== accounts.join(',')) {
    sel.replaceChildren(...accounts.map((u) => { const o = el('option', '', `@${u}`); o.value = u; return o; }));
  }
  sel.value = S.histAccount || '';
}
async function loadHistory(u) {
  if (!u) return;
  const branch = await ensureDefaultBranch();
  const data = await readJsonOrNull(`data/history/${u}_history.json`, branch);
  const sessions = (Array.isArray(data) ? data : data?.sessions || [])
    .filter((s) => ageMs(s.ended_at || s.tracking_started_at) <= 90 * 86400 * 1000)
    .sort((a, b) => new Date(sessionStart(a)) - new Date(sessionStart(b)));
  S.history[u] = { sessions };
}
function renderHistory() {
  renderHistAccountSelect();
  const u = S.histAccount;
  const sessions = (u && S.history[u]?.sessions) || [];
  $('btnExportAll').disabled = sessions.length === 0;
  const peaks = sessions.map((s) => Number(s.peak_viewers) || 0);
  $('hSessions').textContent = fmtNum(sessions.length);
  $('hAvgPeak').textContent = sessions.length ? fmtNum(Math.round(peaks.reduce((a, b) => a + b, 0) / sessions.length)) : '-';
  $('hMaxPeak').textContent = sessions.length ? fmtNum(Math.max(...peaks)) : '-';
  $('hTotalHours').textContent = sessions.length ? (sessions.reduce((a, s) => a + (Number(s.duration_sec) || 0), 0) / 3600).toFixed(1) : '-';

  const tbody = $('historyTable');
  tbody.replaceChildren();
  if (!sessions.length) {
    const tr = el('tr'); const td = el('td', 'py-4 text-slate-500', u ? 'Belum ada sesi live tercatat dalam 90 hari terakhir.' : 'Belum ada akun.'); td.colSpan = 7; tr.append(td); tbody.append(tr);
  }
  [...sessions].reverse().forEach((s) => {
    const tr = el('tr');
    const title = el('td', 'py-2 pr-4 max-w-xs truncate text-slate-300', s.title || '-'); title.title = s.title || '';
    tr.append(
      el('td', 'py-2 pr-4', fmtWIB(sessionStart(s))),
      el('td', 'py-2 pr-4 tabular-nums', fmtDuration(s.duration_sec)),
      el('td', 'py-2 pr-4 text-right tabular-nums', fmtNum(s.peak_viewers)),
      el('td', 'py-2 pr-4 text-right tabular-nums', fmtNum(s.avg_viewers)),
      el('td', 'py-2 pr-4 text-right tabular-nums', fmtNum(s.total_likes)),
      el('td', 'py-2 pr-4 text-right tabular-nums', fmtNum(s.total_comments)),
      title
    );
    tbody.append(tr);
  });
  renderTrendChart(sessions);
  renderReleases();
}
function renderTrendChart(sessions) {
  if (S.trendChart) { S.trendChart.destroy(); S.trendChart = null; }
  $('chartEmpty').classList.toggle('hidden', sessions.length > 0);
  if (!sessions.length || typeof Chart === 'undefined') return;
  S.trendChart = new Chart($('trendChart'), {
    data: {
      labels: sessions.map((s) => `${fmtDateShort(sessionStart(s))} ${fmtTimeWIB(sessionStart(s)).slice(0, 5)}`),
      datasets: [
        { type: 'line', label: 'Peak Viewers', yAxisID: 'y', data: sessions.map((s) => Number(s.peak_viewers) || 0), borderColor: '#f43f5e', backgroundColor: '#f43f5e', tension: 0.3, pointRadius: 3, order: 1 },
        { type: 'bar', label: 'Durasi Live (menit)', yAxisID: 'y1', data: sessions.map((s) => Math.round((Number(s.duration_sec) || 0) / 60)), backgroundColor: 'rgba(99,102,241,.45)', borderRadius: 4, order: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#cbd5e1' } },
        tooltip: { callbacks: { afterBody: (items) => { const s = sessions[items[0].dataIndex]; return [`Likes: ${fmtNum(s.total_likes)}`, `Komentar: ${fmtNum(s.total_comments)}`]; } } }
      },
      scales: {
        x: { ticks: { color: '#94a3b8', maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(148,163,184,.08)' } },
        y: { position: 'left', beginAtZero: true, title: { display: true, text: 'Peak Viewers', color: '#f43f5e' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.08)' } },
        y1: { position: 'right', beginAtZero: true, title: { display: true, text: 'Durasi (menit)', color: '#818cf8' }, ticks: { color: '#94a3b8' }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

// Export XLSX (dibuat di browser dari file histori)
const END_REASON_LABEL = { stream_end: 'Live diakhiri host', disconnected: 'Koneksi terputus', max_duration: 'Batas durasi run tercapai', signal: 'Dihentikan (sinyal/timeout)', idle_offline: 'Live tidak aktif lagi' };
function wibDateTime(iso) {
  if (!iso) return '';
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  if (p.hour === '24') p.hour = '00';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function styleHeader(row) {
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}
async function exportAllXlsx() {
  if (typeof ExcelJS === 'undefined') return toast('Library ExcelJS gagal dimuat (cek koneksi/CDN).', 'error');
  const u = S.histAccount;
  const sessions = S.history[u]?.sessions || [];
  if (!sessions.length) return;
  const btn = $('btnExportAll');
  btn.disabled = true; btn.textContent = 'Menyiapkan file...';
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'TikTok Live Tracker Dashboard';
    const used = new Set();
    const sheetName = (name) => {
      let base = name.replace(/[\[\]*?/\\:]/g, '.').slice(0, 31), c = base, i = 2;
      while (used.has(c.toLowerCase())) { const suf = ` (${i++})`; c = base.slice(0, 31 - suf.length) + suf; }
      used.add(c.toLowerCase());
      return c;
    };
    const ws = wb.addWorksheet(sheetName('Summary 3 Bulan'));
    ws.getCell('A1').value = `Rekap Live @${u} - 90 hari terakhir`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = `Diekspor: ${wibDateTime(new Date().toISOString())} WIB | Jumlah sesi: ${sessions.length}`;
    const cols = [['No', 5], ['Tanggal (WIB)', 13], ['Mulai Live (WIB)', 20], ['Selesai (WIB)', 20], ['Durasi', 10], ['Durasi (menit)', 10], ['Peak Viewers', 11], ['Avg Viewers', 11], ['Total Likes', 12], ['Komentar', 10], ['Komentator Unik', 11], ['Follow Baru', 9], ['Share', 8], ['Judul Live', 36], ['Alasan Selesai', 24], ['Release Tag', 34]];
    const hr = ws.getRow(4);
    cols.forEach(([h, w], i) => { hr.getCell(i + 1).value = h; ws.getColumn(i + 1).width = w; });
    styleHeader(hr);
    sessions.forEach((s, i) => {
      const start = sessionStart(s);
      ws.getRow(5 + i).values = [i + 1, wibDateTime(start).slice(0, 10), wibDateTime(start), wibDateTime(s.ended_at), fmtDuration(s.duration_sec),
        Math.round((Number(s.duration_sec) || 0) / 60), Number(s.peak_viewers) || 0, Number(s.avg_viewers) || 0, Number(s.total_likes) || 0,
        Number(s.total_comments) || 0, Number(s.unique_commenters) || 0, Number(s.follows) || 0, Number(s.shares) || 0, s.title || '',
        END_REASON_LABEL[s.end_reason] || s.end_reason || '', s.release_tag || ''];
    });
    const first = 5, last = 4 + sessions.length, tr = ws.getRow(last + 1);
    tr.getCell(1).value = 'TOTAL / RATA2';
    tr.getCell(6).value = { formula: `SUM(F${first}:F${last})` };
    tr.getCell(7).value = { formula: `ROUND(AVERAGE(G${first}:G${last}),0)` };
    tr.getCell(8).value = { formula: `ROUND(AVERAGE(H${first}:H${last}),0)` };
    tr.getCell(9).value = { formula: `SUM(I${first}:I${last})` };
    tr.getCell(10).value = { formula: `SUM(J${first}:J${last})` };
    tr.getCell(12).value = { formula: `SUM(L${first}:L${last})` };
    tr.getCell(13).value = { formula: `SUM(M${first}:M${last})` };
    tr.font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: last, column: cols.length } };

    sessions.forEach((s, i) => {
      const start = wibDateTime(sessionStart(s));
      const d = wb.addWorksheet(sheetName(`#${String(i + 1).padStart(2, '0')} ${start.slice(0, 10)} ${start.slice(11, 16).replace(':', '.')}`));
      [24, 22, 3, 6, 22, 22, 10, 3, 6, 20, 14].forEach((w, ci) => { d.getColumn(ci + 1).width = w; });
      d.getCell('A1').value = `Detail Sesi Live @${u}`;
      d.getCell('A1').font = { bold: true, size: 14 };
      const info = [['Judul Live', s.title || '-'], ['Room ID', s.room_id || '-'], ['Mulai Live (WIB)', wibDateTime(s.live_started_at) || '(tidak diketahui)'],
        ['Mulai Tracking (WIB)', wibDateTime(s.tracking_started_at)], ['Selesai (WIB)', wibDateTime(s.ended_at)], ['Durasi Live', fmtDuration(s.duration_sec)],
        ['Durasi Ter-track', fmtDuration(s.tracked_duration_sec)], ['Peak Viewers', Number(s.peak_viewers) || 0], ['Waktu Peak (WIB)', wibDateTime(s.peak_viewers_at) || '-'],
        ['Avg Viewers', Number(s.avg_viewers) || 0], ['Total Likes', Number(s.total_likes) || 0], ['Total Komentar', Number(s.total_comments) || 0],
        ['Komentator Unik', Number(s.unique_commenters) || 0], ['Follow Baru', Number(s.follows) || 0], ['Share', Number(s.shares) || 0],
        ['Alasan Selesai', END_REASON_LABEL[s.end_reason] || s.end_reason || '-'], ['Release Tag', s.release_tag || '-']];
      info.forEach(([k, v], idx) => { const r = d.getRow(3 + idx); r.getCell(1).value = k; r.getCell(1).font = { bold: true }; r.getCell(2).value = v; });
      const t0 = 3 + info.length + 1, th = d.getRow(t0);
      th.getCell(1).value = 'Waktu (WIB)'; th.getCell(2).value = 'Viewers';
      th.getCell(4).value = '#'; th.getCell(5).value = 'Username'; th.getCell(6).value = 'Nickname'; th.getCell(7).value = 'Komentar';
      th.getCell(9).value = '#'; th.getCell(10).value = 'Kata Kunci'; th.getCell(11).value = 'Jml Komentar';
      styleHeader(th);
      (s.viewer_timeline || []).forEach((p, k) => { const r = d.getRow(t0 + 1 + k); r.getCell(1).value = wibDateTime(p.t); r.getCell(2).value = Number(p.v) || 0; });
      (s.top_commenters || []).forEach((c, k) => { const r = d.getRow(t0 + 1 + k); r.getCell(4).value = k + 1; r.getCell(5).value = c.user; r.getCell(6).value = c.nickname || ''; r.getCell(7).value = Number(c.count) || 0; });
      (s.top_keywords || []).forEach((w, k) => { const r = d.getRow(t0 + 1 + k); r.getCell(9).value = k + 1; r.getCell(10).value = w.word; r.getCell(11).value = Number(w.count) || 0; });
      d.views = [{ state: 'frozen', ySplit: t0 }];
    });

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `Report_${u}_3_Months.xlsx`;
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Rekap 3 bulan diunduh. Chat log lengkap per sesi ada di file Session_*.xlsx.', 'ok');
  } catch (e) {
    console.error(e); toast(`Export gagal: ${e.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Export All Data (3 Months .XLSX)';
  }
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------
async function loadReleases() {
  try {
    const list = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await gh(`${repoPath()}/releases?per_page=100&page=${page}`);
      list.push(...batch);
      if (batch.length < 100) break;
    }
    S.releases = list;
  } catch (e) {
    console.warn('releases:', e.message);
    S.releases = [];
  }
}
function parseTag(tag) {
  if (tag.startsWith('rekap-')) return { user: tag.slice(6), type: 'rekap' };
  const m = tag.match(/^(live|rec)-(.+)-\d{8}-\d{6}$/);
  return m ? { user: m[2], type: m[1] } : null;
}
function releaseAssets() {
  const rows = [];
  for (const r of S.releases) {
    const t = parseTag(r.tag_name || '');
    if (!t) continue;
    for (const a of r.assets || []) {
      const ext = (a.name.split('.').pop() || '').toLowerCase();
      if (!['xlsx', 'mp4', 'ts'].includes(ext)) continue;
      const kind = ext === 'xlsx' ? (t.type === 'rekap' ? 'rekap' : a.name.startsWith('Report_') ? 'rekap-sesi' : 'sesi') : 'video';
      rows.push({ asset: a, release: r, user: t.user, kind });
    }
  }
  const prio = { rekap: 0, sesi: 1, video: 1, 'rekap-sesi': 2 };
  return rows.sort((x, y) => (prio[x.kind] - prio[y.kind]) || (new Date(y.asset.updated_at) - new Date(x.asset.updated_at)));
}
function downloadCell(asset) {
  const td = el('td', 'py-2 text-right');
  const a = el('a', 'inline-block rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-semibold whitespace-nowrap', 'Download');
  a.href = asset.browser_download_url; a.rel = 'noopener';
  td.append(a);
  return td;
}
function renderReleases() {
  const only = $('inOnlySelected').checked;
  const rows = releaseAssets().filter((r) => !only || r.user === S.histAccount);
  const tbody = $('releaseTable');
  tbody.replaceChildren();
  if (!rows.length) {
    const tr = el('tr'); const td = el('td', 'py-4 text-slate-500', 'Belum ada file di GitHub Releases.'); td.colSpan = 6; tr.append(td); tbody.append(tr);
    return;
  }
  const label = { rekap: ['Rekap 3 Bulan', 'bg-emerald-500/20 text-emerald-300'], 'rekap-sesi': ['Rekap (saat sesi)', 'bg-slate-700 text-slate-300'], sesi: ['Laporan Sesi', 'bg-sky-500/20 text-sky-300'], video: ['Video', 'bg-rose-500/20 text-rose-300'] };
  for (const r of rows) {
    const tr = el('tr');
    const typeTd = el('td', 'py-2 pr-4');
    typeTd.append(el('span', `rounded-full px-2 py-0.5 text-xs font-semibold ${label[r.kind][1]}`, label[r.kind][0]));
    tr.append(
      el('td', 'py-2 pr-4 font-medium break-all', r.asset.name), typeTd,
      el('td', 'py-2 pr-4', `@${r.user}`),
      el('td', 'py-2 pr-4 text-right tabular-nums', fmtBytes(r.asset.size)),
      el('td', 'py-2 pr-4 whitespace-nowrap', fmtWIB(r.asset.updated_at)),
      downloadCell(r.asset)
    );
    tbody.append(tr);
  }
}

// ---------------------------------------------------------------------------
// Tab & siklus refresh
// ---------------------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  document.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  lsSet(LS.tab, name);
  if (name === 'history' && S.histAccount && !S.history[S.histAccount]) loadHistory(S.histAccount).then(renderHistory);
}
function renderAll() {
  renderHeader();
  renderTiktokers();
  renderDetail();
  renderRecord();
  renderHistAccountSelect();
}

async function refreshAll() {
  if (!S.owner || !S.repo) { renderAll(); return; }
  try { await loadConfig(); } catch (e) { toast(`Gagal membaca data/config.json: ${e.message}`, 'error'); }
  await Promise.all([pollLive(), loadReleases()]);
  renderHistAccountSelect();
  if (S.histAccount) await loadHistory(S.histAccount);
  renderAll();
  renderHistory();
  restartPolling();
}

function restartPolling() {
  clearInterval(S.pollTimer);
  const every = S.token ? 15_000 : 120_000;
  $('pollInfo').textContent = `refresh tiap ${every / 1000} dtk`;
  let tick = 0;
  S.pollTimer = setInterval(async () => {
    if (document.hidden || !S.owner) return;
    tick += 1;
    const liveBefore = new Set(S.config.accounts.filter((u) => stateOf(u) === 'live'));
    if (tick % 8 === 0) { try { await loadConfig(); } catch { /* abaikan */ } }
    await pollLive();
    // Ada live yang baru selesai -> muat ulang histori & releases setelah upload (±5 menit)
    const ended = [...liveBefore].filter((u) => stateOf(u) !== 'live');
    if (ended.length) setTimeout(async () => { await loadReleases(); if (S.histAccount) await loadHistory(S.histAccount); renderHistory(); renderRecord(); }, 5 * 60_000);
  }, every);

  clearInterval(S.tickTimer);
  S.tickTimer = setInterval(() => {
    if (document.hidden) return;
    // update durasi tiap detik tanpa request tambahan
    if (S.selected && snapFresh(S.live[S.selected])) $('dDuration').textContent = fmtDuration(liveDurationSec(S.live[S.selected]));
  }, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('btnToggleSettings').addEventListener('click', () => $('settingsPanel').classList.toggle('hidden'));
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnClearToken').addEventListener('click', clearToken);
  $('btnRunDetector').addEventListener('click', runDetector);
  $('btnRefresh').addEventListener('click', () => refreshAll());
  $('btnAddAccount').addEventListener('click', addAccount);
  $('inNewAccount').addEventListener('keydown', (e) => { if (e.key === 'Enter') addAccount(); });
  $('btnCloseDetail').addEventListener('click', closeDetail);
  $('inAutoRecord').addEventListener('change', (e) => setAutoRecord(e.target.checked));
  $('histAccount').addEventListener('change', async (e) => { S.histAccount = e.target.value; if (!S.history[S.histAccount]) await loadHistory(S.histAccount); renderHistory(); });
  $('btnExportAll').addEventListener('click', exportAllXlsx);
  $('inOnlySelected').addEventListener('change', () => { lsSet(LS.onlySel, String($('inOnlySelected').checked)); renderReleases(); });
  $('inToken').addEventListener('focus', (e) => { if (e.target.value.startsWith('•')) e.target.value = ''; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.owner) pollLive(); });

  loadSettings();
  showTab(lsGet(LS.tab) || 'tiktokers');
  refreshAll();
});
