/* TikTok Live Tracker - Dashboard (GitHub Pages)
 * Membaca:
 *   - data/config.json                 (branch default)  -> form target & auto record
 *   - live/<username>.json             (branch live-status) -> status live, counter, chat
 *   - data/history/<username>_history.json (branch default) -> grafik & export 3 bulan
 *   - GitHub Releases                  -> daftar file .xlsx / .mp4
 * Menulis:
 *   - data/config.json via GitHub REST API (butuh PAT)
 *   - workflow_dispatch untuk "Cek Sekarang" (butuh PAT dengan izin Actions)
 */
'use strict';

const API = 'https://api.github.com';
const TZ = 'Asia/Jakarta';
const LIVE_BRANCH = 'live-status';
const WORKFLOW_FILE = 'monitor_live.yml';
const USERNAME_RE = /^[a-z0-9._]{2,24}$/;
const LS = { token: 'tlt.pat', owner: 'tlt.owner', repo: 'tlt.repo', onlyTarget: 'tlt.onlyTarget' };

const $ = (id) => document.getElementById(id);

const S = {
  owner: '',
  repo: '',
  token: '',
  defaultBranch: null,
  config: null,
  configSha: null,
  username: '',
  history: null,
  live: null,
  chart: null,
  pollTimer: null,
  tickTimer: null,
  releases: []
};

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) {
  try { if (v === null || v === undefined || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* mode privat */ }
}

const nf = new Intl.NumberFormat('id-ID');
const fmtNum = (n) => (Number.isFinite(Number(n)) ? nf.format(Number(n)) : '-');

function fmtWIB(iso, withSeconds = false) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false
  }).format(d);
}
function fmtTimeWIB(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso));
}
function fmtDateShort(iso) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: 'short' }).format(new Date(iso));
}
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (!b && b !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function normalizeUsername(v) { return String(v || '').trim().replace(/^@+/, '').toLowerCase(); }
function sessionStart(s) { return s.live_started_at || s.tracking_started_at || s.ended_at; }

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

let toastTimer = null;
function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'fixed bottom-4 right-4 max-w-sm rounded-xl px-4 py-3 text-sm shadow-lg ' +
    (type === 'error' ? 'bg-rose-600 text-white' : type === 'ok' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-100');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------
class GhError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(path, { method = 'GET', body, accept = 'application/vnd.github+json', auth = true } = {}) {
  const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (auth && S.token) headers.Authorization = `Bearer ${S.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch { /* abaikan */ }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      msg = 'Rate limit GitHub API habis. Isi PAT di Pengaturan supaya limit naik ke 5.000/jam.';
    }
    throw new GhError(res.status, msg);
  }
  if (res.status === 204) return null;
  return accept.includes('raw') ? res.text() : res.json();
}

const repoPath = () => `/repos/${encodeURIComponent(S.owner)}/${encodeURIComponent(S.repo)}`;

async function ensureDefaultBranch() {
  if (S.defaultBranch) return S.defaultBranch;
  try {
    const info = await gh(repoPath());
    S.defaultBranch = info.default_branch || 'main';
  } catch {
    S.defaultBranch = 'main';
  }
  return S.defaultBranch;
}

async function readRawFile(path, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return gh(`${repoPath()}/contents/${path}${q}`, { accept: 'application/vnd.github.raw+json' });
}

// ---------------------------------------------------------------------------
// Pengaturan repo & token
// ---------------------------------------------------------------------------
function detectRepoFromUrl() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return {};
  const owner = host.replace(/\.github\.io$/, '');
  const first = location.pathname.split('/').filter(Boolean)[0];
  return { owner, repo: first || `${owner}.github.io` };
}

function loadSettings() {
  const detected = detectRepoFromUrl();
  S.owner = lsGet(LS.owner) || detected.owner || '';
  S.repo = lsGet(LS.repo) || detected.repo || '';
  S.token = lsGet(LS.token) || '';
  $('inOwner').value = S.owner;
  $('inRepo').value = S.repo;
  $('inToken').value = S.token ? '••••••••••••' : '';
  $('inOnlyTarget').checked = lsGet(LS.onlyTarget) !== 'false';
  updateRepoLabel();
  if (!S.owner || !S.repo || !S.token) $('settingsPanel').classList.remove('hidden');
}

function updateRepoLabel() {
  $('repoLabel').textContent = S.owner && S.repo
    ? `${S.owner}/${S.repo} ${S.token ? '· token tersimpan' : '· tanpa token (read-only, limit 60 req/jam)'}`
    : 'Repo belum diatur, buka Pengaturan';
}

async function saveSettings() {
  const owner = $('inOwner').value.trim();
  const repo = $('inRepo').value.trim();
  const tokenInput = $('inToken').value.trim();
  if (!owner || !repo) { $('settingsMsg').textContent = 'Owner & repository wajib diisi.'; return; }

  S.owner = owner; S.repo = repo; S.defaultBranch = null;
  if (tokenInput && !tokenInput.startsWith('•')) S.token = tokenInput;
  lsSet(LS.owner, owner); lsSet(LS.repo, repo); lsSet(LS.token, S.token);
  $('inToken').value = S.token ? '••••••••••••' : '';

  $('settingsMsg').textContent = 'Mengetes koneksi...';
  try {
    const info = await gh(repoPath());
    S.defaultBranch = info.default_branch;
    const canPush = info.permissions ? info.permissions.push : false;
    $('settingsMsg').textContent = S.token
      ? (canPush ? 'Terhubung, token punya akses tulis.' : 'Terhubung, tapi token TIDAK punya akses tulis ke repo ini.')
      : 'Terhubung tanpa token (hanya bisa membaca).';
    updateRepoLabel();
    await refreshAll();
  } catch (e) {
    $('settingsMsg').textContent = `Gagal: ${e.message}`;
  }
}

function clearToken() {
  S.token = '';
  lsSet(LS.token, null);
  $('inToken').value = '';
  updateRepoLabel();
  toast('Token dihapus dari browser ini.');
  restartPolling();
}

// ---------------------------------------------------------------------------
// Config (data/config.json)
// ---------------------------------------------------------------------------
async function loadConfig() {
  const branch = await ensureDefaultBranch();
  const file = await gh(`${repoPath()}/contents/data/config.json?ref=${encodeURIComponent(branch)}`);
  S.configSha = file.sha;
  S.config = JSON.parse(b64DecodeUtf8(file.content));
  S.username = normalizeUsername(S.config.target_username);
  $('inTarget').value = S.username === 'username_target' ? '' : S.username;
  $('inAutoRecord').checked = S.config.auto_record_enabled !== false;
  $('configMsg').textContent = S.username && S.username !== 'username_target'
    ? `Memantau @${S.username}. Auto record: ${S.config.auto_record_enabled !== false ? 'ON' : 'OFF'}.`
    : 'Target username belum diisi.';
}

async function saveConfig() {
  if (!S.token) { toast('Isi Personal Access Token dulu di Pengaturan.', 'error'); return; }
  const username = normalizeUsername($('inTarget').value);
  if (!USERNAME_RE.test(username)) {
    toast('Username tidak valid (huruf kecil, angka, titik, underscore; 2-24 karakter).', 'error');
    return;
  }
  const btn = $('btnSaveConfig');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const branch = await ensureDefaultBranch();
    const latest = await gh(`${repoPath()}/contents/data/config.json?ref=${encodeURIComponent(branch)}`);
    const current = JSON.parse(b64DecodeUtf8(latest.content));
    const next = { ...current, target_username: username, auto_record_enabled: $('inAutoRecord').checked };
    await gh(`${repoPath()}/contents/data/config.json`, {
      method: 'PUT',
      body: {
        message: `chore(config): target @${username}, auto record ${next.auto_record_enabled ? 'ON' : 'OFF'} (dashboard)`,
        content: b64EncodeUtf8(JSON.stringify(next, null, 2) + '\n'),
        sha: latest.sha,
        branch
      }
    });
    toast('Config tersimpan. Berlaku di run workflow berikutnya.', 'ok');
    await refreshAll();
  } catch (e) {
    toast(`Gagal simpan config: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Config';
  }
}

async function runNow() {
  if (!S.token) { toast('Isi Personal Access Token dulu di Pengaturan.', 'error'); return; }
  try {
    const branch = await ensureDefaultBranch();
    await gh(`${repoPath()}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { method: 'POST', body: { ref: branch } });
    toast('Workflow dipicu. Kalau sedang live, data muncul ±2-3 menit lagi.', 'ok');
  } catch (e) {
    toast(e.status === 403 || e.status === 404
      ? 'Gagal memicu workflow. Pastikan PAT punya izin "Actions: Read and write".'
      : `Gagal memicu workflow: ${e.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Live status (branch live-status)
// ---------------------------------------------------------------------------
function isLiveFresh(live) {
  if (!live || live.status !== 'online') return false;
  const interval = (Number(live.snapshot_interval_sec) || 60) * 1000;
  const staleAfter = Math.max(4 * 60 * 1000, interval * 4);
  return Date.now() - new Date(live.updated_at).getTime() < staleAfter;
}

async function loadLive() {
  if (!S.username || S.username === 'username_target') { S.live = null; renderLive(); return; }
  try {
    const raw = await readRawFile(`live/${S.username}.json`, LIVE_BRANCH);
    S.live = JSON.parse(raw);
  } catch (e) {
    if (e.status !== 404) console.warn('loadLive:', e.message);
    S.live = null;
  }
  renderLive();
}

function setBadge(online) {
  const b = $('statusBadge');
  if (online) {
    b.className = 'ml-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold bg-rose-600 text-white';
    b.innerHTML = '<span class="w-2 h-2 rounded-full bg-white pulse-dot"></span> ONLINE';
  } else {
    b.className = 'ml-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold bg-slate-800 text-slate-300';
    b.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-500"></span> OFFLINE';
  }
}

function liveDurationSec(live) {
  const start = live.live_started_at || live.tracking_started_at;
  return start ? (Date.now() - new Date(start).getTime()) / 1000 : Number(live.duration_sec) || 0;
}

function renderLive() {
  const live = S.live;
  const online = isLiveFresh(live);
  setBadge(online);

  const banner = $('liveBanner');
  if (online) {
    banner.classList.remove('hidden');
    $('liveBannerText').textContent = `@${live.username}${live.title ? ` · "${live.title}"` : ''} · sejak ${fmtTimeWIB(live.live_started_at || live.tracking_started_at)} WIB`;
    $('liveBannerLink').href = `https://www.tiktok.com/@${encodeURIComponent(live.username)}/live`;
  } else {
    banner.classList.add('hidden');
  }

  if (!live) {
    ['cCurrent', 'cPeak', 'cDuration', 'cLikes', 'cComments', 'cSocial'].forEach((id) => { $(id).textContent = '-'; });
    $('liveMeta').textContent = 'Belum ada data live untuk akun ini. Data muncul otomatis saat akun mulai live.';
    renderChats([]);
    return;
  }

  $('cCurrent').textContent = online ? fmtNum(live.current_viewers) : '0';
  $('cPeak').textContent = fmtNum(live.peak_viewers);
  $('cDuration').textContent = fmtDuration(online ? liveDurationSec(live) : live.duration_sec);
  $('cLikes').textContent = fmtNum(live.total_likes);
  $('cComments').textContent = fmtNum(live.total_comments);
  $('cSocial').textContent = `${fmtNum(live.follows)} / ${fmtNum(live.shares)}`;
  $('liveMeta').textContent = online
    ? `Snapshot terakhir: ${fmtWIB(live.updated_at, true)} WIB · diperbarui tiap ±${live.snapshot_interval_sec || 60} detik.`
    : `Sesi terakhir: ${fmtWIB(live.live_started_at || live.tracking_started_at)} - ${fmtWIB(live.updated_at)} WIB (angka di atas = hasil akhir sesi).`;
  renderChats(live.recent_chats || []);
}

function renderChats(chats) {
  const box = $('chatBox');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.replaceChildren();
  if (!chats.length) {
    const li = document.createElement('li');
    li.className = 'text-slate-500';
    li.textContent = 'Belum ada chat.';
    box.appendChild(li);
  }
  for (const c of chats) {
    // textContent saja: isi chat dari publik, jangan pernah dirender sebagai HTML
    const li = document.createElement('li');
    li.className = 'leading-snug';
    const time = document.createElement('span');
    time.className = 'text-[11px] text-slate-500 mr-1.5 tabular-nums';
    time.textContent = fmtTimeWIB(c.time);
    const user = document.createElement('span');
    user.className = 'font-semibold text-indigo-300 mr-1.5';
    user.textContent = c.nickname || `@${c.user}`;
    user.title = `@${c.user}`;
    const msg = document.createElement('span');
    msg.className = 'text-slate-200 break-words';
    msg.textContent = c.comment;
    li.append(time, user, msg);
    box.appendChild(li);
  }
  $('chatCount').textContent = `${chats.length} komentar terakhir`;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// Histori 3 bulan
// ---------------------------------------------------------------------------
async function loadHistory() {
  $('histFileName').textContent = S.username ? `${S.username}_history.json` : '-';
  if (!S.username || S.username === 'username_target') { S.history = null; renderHistory(); return; }
  try {
    const branch = await ensureDefaultBranch();
    const raw = await readRawFile(`data/history/${S.username}_history.json`, branch);
    const parsed = JSON.parse(raw);
    S.history = Array.isArray(parsed) ? { username: S.username, sessions: parsed } : parsed;
  } catch (e) {
    if (e.status !== 404) toast(`Gagal memuat histori: ${e.message}`, 'error');
    S.history = { username: S.username, sessions: [] };
  }
  // Filter 90 hari di sisi browser juga (jaga-jaga kalau prune belum jalan)
  const cutoff = Date.now() - 90 * 86400 * 1000;
  S.history.sessions = (S.history.sessions || [])
    .filter((s) => new Date(s.ended_at || s.tracking_started_at).getTime() >= cutoff)
    .sort((a, b) => new Date(sessionStart(a)) - new Date(sessionStart(b)));
  renderHistory();
}

function renderHistory() {
  const sessions = S.history?.sessions || [];
  $('btnExportAll').disabled = sessions.length === 0;

  const peaks = sessions.map((s) => Number(s.peak_viewers) || 0);
  const totalSec = sessions.reduce((a, s) => a + (Number(s.duration_sec) || 0), 0);
  $('hSessions').textContent = fmtNum(sessions.length);
  $('hAvgPeak').textContent = sessions.length ? fmtNum(Math.round(peaks.reduce((a, b) => a + b, 0) / sessions.length)) : '-';
  $('hMaxPeak').textContent = sessions.length ? fmtNum(Math.max(...peaks)) : '-';
  $('hTotalHours').textContent = sessions.length ? (totalSec / 3600).toFixed(1) : '-';

  // Tabel (terbaru di atas)
  const tbody = $('historyTable');
  tbody.replaceChildren();
  if (!sessions.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'py-4 text-slate-500';
    td.textContent = 'Belum ada sesi live tercatat dalam 90 hari terakhir.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  [...sessions].reverse().forEach((s) => {
    const tr = document.createElement('tr');
    const cells = [
      [fmtWIB(sessionStart(s)), ''],
      [fmtDuration(s.duration_sec), 'tabular-nums'],
      [fmtNum(s.peak_viewers), 'text-right tabular-nums'],
      [fmtNum(s.avg_viewers), 'text-right tabular-nums'],
      [fmtNum(s.total_likes), 'text-right tabular-nums'],
      [fmtNum(s.total_comments), 'text-right tabular-nums'],
      [s.title || '-', 'max-w-xs truncate text-slate-300']
    ];
    cells.forEach(([text, cls]) => {
      const td = document.createElement('td');
      td.className = `py-2 pr-4 ${cls}`;
      td.textContent = text;
      if (cls.includes('truncate')) td.title = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  renderChart(sessions);
}

function renderChart(sessions) {
  if (S.chart) { S.chart.destroy(); S.chart = null; }
  $('chartEmpty').classList.toggle('hidden', sessions.length > 0);
  if (!sessions.length || typeof Chart === 'undefined') return;

  const labels = sessions.map((s) => `${fmtDateShort(sessionStart(s))} ${fmtTimeWIB(sessionStart(s)).slice(0, 5)}`);
  S.chart = new Chart($('trendChart'), {
    data: {
      labels,
      datasets: [
        {
          type: 'line', label: 'Peak Viewers', yAxisID: 'y',
          data: sessions.map((s) => Number(s.peak_viewers) || 0),
          borderColor: '#f43f5e', backgroundColor: '#f43f5e', tension: 0.3, pointRadius: 3, order: 1
        },
        {
          type: 'bar', label: 'Durasi Live (menit)', yAxisID: 'y1',
          data: sessions.map((s) => Math.round((Number(s.duration_sec) || 0) / 60)),
          backgroundColor: 'rgba(99,102,241,.45)', borderRadius: 4, order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#cbd5e1' } },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const s = sessions[items[0].dataIndex];
              return [`Likes: ${fmtNum(s.total_likes)}`, `Komentar: ${fmtNum(s.total_comments)}`];
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#94a3b8', maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(148,163,184,.08)' } },
        y: { position: 'left', beginAtZero: true, title: { display: true, text: 'Peak Viewers', color: '#f43f5e' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.08)' } },
        y1: { position: 'right', beginAtZero: true, title: { display: true, text: 'Durasi (menit)', color: '#818cf8' }, ticks: { color: '#94a3b8' }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Export XLSX 3 bulan (dibuat di browser dari file histori)
// ---------------------------------------------------------------------------
const END_REASON_LABEL = {
  stream_end: 'Live diakhiri host',
  disconnected: 'Koneksi terputus',
  max_duration: 'Batas durasi run tercapai',
  signal: 'Dihentikan (sinyal/timeout)',
  idle_offline: 'Live tidak aktif lagi'
};

function wibDateTime(iso) {
  if (!iso) return '';
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
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
  if (typeof ExcelJS === 'undefined') { toast('Library ExcelJS gagal dimuat (cek koneksi/CDN).', 'error'); return; }
  const sessions = S.history?.sessions || [];
  if (!sessions.length) return;
  const btn = $('btnExportAll');
  btn.disabled = true;
  btn.textContent = 'Menyiapkan file...';
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
    ws.getCell('A1').value = `Rekap Live @${S.username} - 90 hari terakhir`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = `Diekspor: ${wibDateTime(new Date().toISOString())} WIB | Jumlah sesi: ${sessions.length}`;
    const cols = [
      ['No', 5], ['Tanggal (WIB)', 13], ['Mulai Live (WIB)', 20], ['Selesai (WIB)', 20], ['Durasi', 10], ['Durasi (menit)', 10],
      ['Peak Viewers', 11], ['Avg Viewers', 11], ['Total Likes', 12], ['Komentar', 10], ['Komentator Unik', 11],
      ['Follow Baru', 9], ['Share', 8], ['Judul Live', 36], ['Alasan Selesai', 24], ['Release Tag', 34]
    ];
    const hr = ws.getRow(4);
    cols.forEach(([h, w], i) => { hr.getCell(i + 1).value = h; ws.getColumn(i + 1).width = w; });
    styleHeader(hr);
    sessions.forEach((s, i) => {
      const start = sessionStart(s);
      ws.getRow(5 + i).values = [
        i + 1, wibDateTime(start).slice(0, 10), wibDateTime(start), wibDateTime(s.ended_at), fmtDuration(s.duration_sec),
        Math.round((Number(s.duration_sec) || 0) / 60), Number(s.peak_viewers) || 0, Number(s.avg_viewers) || 0,
        Number(s.total_likes) || 0, Number(s.total_comments) || 0, Number(s.unique_commenters) || 0,
        Number(s.follows) || 0, Number(s.shares) || 0, s.title || '', END_REASON_LABEL[s.end_reason] || s.end_reason || '', s.release_tag || ''
      ];
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
      d.getCell('A1').value = `Detail Sesi Live @${s.username || S.username}`;
      d.getCell('A1').font = { bold: true, size: 14 };
      const info = [
        ['Judul Live', s.title || '-'], ['Room ID', s.room_id || '-'],
        ['Mulai Live (WIB)', wibDateTime(s.live_started_at) || '(tidak diketahui)'],
        ['Mulai Tracking (WIB)', wibDateTime(s.tracking_started_at)], ['Selesai (WIB)', wibDateTime(s.ended_at)],
        ['Durasi Live', fmtDuration(s.duration_sec)], ['Durasi Ter-track', fmtDuration(s.tracked_duration_sec)],
        ['Peak Viewers', Number(s.peak_viewers) || 0], ['Waktu Peak (WIB)', wibDateTime(s.peak_viewers_at) || '-'],
        ['Avg Viewers', Number(s.avg_viewers) || 0], ['Total Likes', Number(s.total_likes) || 0],
        ['Total Komentar', Number(s.total_comments) || 0], ['Komentator Unik', Number(s.unique_commenters) || 0],
        ['Follow Baru', Number(s.follows) || 0], ['Share', Number(s.shares) || 0],
        ['Alasan Selesai', END_REASON_LABEL[s.end_reason] || s.end_reason || '-'], ['Release Tag', s.release_tag || '-']
      ];
      info.forEach(([k, v], idx) => {
        const r = d.getRow(3 + idx);
        r.getCell(1).value = k; r.getCell(1).font = { bold: true }; r.getCell(2).value = v;
      });
      const t0 = 3 + info.length + 1;
      const th = d.getRow(t0);
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
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Report_${S.username}_3_Months.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('File rekap 3 bulan diunduh. Chat log lengkap per sesi ada di file Session_*.xlsx (tabel download).', 'ok');
  } catch (e) {
    console.error(e);
    toast(`Export gagal: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export All Data (3 Months .XLSX)';
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
    S.releases = [];
    renderReleaseMessage(`Gagal memuat releases: ${e.message}`);
    return;
  }
  renderReleases();
}

function renderReleaseMessage(text) {
  const tbody = $('releaseTable');
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 6;
  td.className = 'py-4 text-slate-500';
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function releaseUsername(tag) {
  if (tag.startsWith('rekap-')) return tag.slice(6);
  const m = tag.match(/^live-(.+)-\d{8}-\d{6}$/);
  return m ? m[1] : null;
}

function renderReleases() {
  const onlyTarget = $('inOnlyTarget').checked;
  const rows = [];
  for (const r of S.releases) {
    const user = releaseUsername(r.tag_name || '');
    if (!user) continue;
    if (onlyTarget && user !== S.username) continue;
    for (const a of r.assets || []) {
      const ext = (a.name.split('.').pop() || '').toLowerCase();
      if (!['xlsx', 'mp4', 'ts'].includes(ext)) continue;
      rows.push({ asset: a, release: r, ext, isRekap: r.tag_name.startsWith('rekap-') });
    }
  }
  rows.sort((x, y) => (y.isRekap - x.isRekap) || (new Date(y.asset.updated_at) - new Date(x.asset.updated_at)));

  if (!rows.length) { renderReleaseMessage('Belum ada file di GitHub Releases.'); return; }

  const tbody = $('releaseTable');
  tbody.replaceChildren();
  for (const { asset, release, ext, isRekap } of rows) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'py-2 pr-4 font-medium break-all';
    tdName.textContent = asset.name;

    const tdType = document.createElement('td');
    tdType.className = 'py-2 pr-4';
    const pill = document.createElement('span');
    pill.className = 'rounded-full px-2 py-0.5 text-xs font-semibold ' +
      (ext === 'xlsx' ? (isRekap ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300') : 'bg-rose-500/20 text-rose-300');
    pill.textContent = ext === 'xlsx' ? (isRekap ? 'Rekap 3 Bulan' : (asset.name.startsWith('Report_') ? 'Rekap (saat sesi)' : 'Laporan Sesi')) : 'Video';
    tdType.appendChild(pill);

    const tdSize = document.createElement('td');
    tdSize.className = 'py-2 pr-4 text-right tabular-nums';
    tdSize.textContent = fmtBytes(asset.size);

    const tdDate = document.createElement('td');
    tdDate.className = 'py-2 pr-4 whitespace-nowrap';
    tdDate.textContent = fmtWIB(asset.updated_at);

    const tdRel = document.createElement('td');
    tdRel.className = 'py-2 pr-4';
    const relLink = document.createElement('a');
    relLink.href = release.html_url;
    relLink.target = '_blank';
    relLink.rel = 'noopener';
    relLink.className = 'text-indigo-300 hover:underline';
    relLink.textContent = release.tag_name;
    tdRel.appendChild(relLink);

    const tdDl = document.createElement('td');
    tdDl.className = 'py-2 text-right';
    const dl = document.createElement('a');
    dl.href = asset.browser_download_url;
    dl.rel = 'noopener';
    dl.className = 'inline-block rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-semibold whitespace-nowrap';
    dl.textContent = 'Download';
    tdDl.appendChild(dl);

    tr.append(tdName, tdType, tdSize, tdDate, tdRel, tdDl);
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Siklus refresh
// ---------------------------------------------------------------------------
async function refreshAll() {
  if (!S.owner || !S.repo) { setBadge(false); renderReleaseMessage('Atur repo di Pengaturan dulu.'); return; }
  try {
    await loadConfig();
  } catch (e) {
    toast(`Gagal membaca data/config.json: ${e.message}`, 'error');
    $('configMsg').textContent = 'Config tidak terbaca. Cek owner/repo & token.';
  }
  await Promise.all([loadLive(), loadHistory(), loadReleases()]);
  restartPolling();
}

function restartPolling() {
  clearInterval(S.pollTimer);
  // Dengan token: 30 detik. Tanpa token: 120 detik (limit 60 request/jam per IP).
  const every = S.token ? 30_000 : 120_000;
  S.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    const wasOnline = isLiveFresh(S.live);
    await loadLive();
    // Live baru selesai -> muat ulang histori & releases (upload butuh beberapa menit)
    if (wasOnline && !isLiveFresh(S.live)) {
      setTimeout(() => { loadHistory(); loadReleases(); }, 5 * 60_000);
    }
  }, every);

  clearInterval(S.tickTimer);
  S.tickTimer = setInterval(() => {
    if (isLiveFresh(S.live)) $('cDuration').textContent = fmtDuration(liveDurationSec(S.live));
  }, 1000);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  $('btnToggleSettings').addEventListener('click', () => $('settingsPanel').classList.toggle('hidden'));
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnClearToken').addEventListener('click', clearToken);
  $('btnSaveConfig').addEventListener('click', saveConfig);
  $('btnRunNow').addEventListener('click', runNow);
  $('btnExportAll').addEventListener('click', exportAllXlsx);
  $('btnRefresh').addEventListener('click', () => refreshAll());
  $('inOnlyTarget').addEventListener('change', () => { lsSet(LS.onlyTarget, String($('inOnlyTarget').checked)); renderReleases(); });
  $('inToken').addEventListener('focus', (e) => { if (e.target.value.startsWith('•')) e.target.value = ''; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.owner) loadLive(); });

  loadSettings();
  refreshAll();
});
