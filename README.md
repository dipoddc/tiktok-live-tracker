# TikTok Live Performance Tracker & Auto-Recorder

Serverless & gratis: **GitHub Actions** (tracking + rekam), **GitHub Releases** (simpan video & Excel), **GitHub Pages** (dashboard).

```
data/config.json                     target username + toggle auto record
data/history/<user>_history.json     ringkasan sesi 90 hari terakhir (auto-prune)
scripts/tracker.js                   analitik live (viewers, likes, chat, durasi) + Excel
scripts/recorder.sh                  rekam video via Streamlink + FFmpeg
.github/workflows/monitor_live.yml   cron 10 menit, tracker & recorder paralel
docs/index.html, docs/app.js         dashboard GitHub Pages
package.json                         dependency Node (exceljs, tiktok-live-connector)
```

Branch `live-status` dibuat otomatis oleh tracker untuk snapshot live (supaya update tiap menit tidak memicu rebuild GitHub Pages).

## Setup

### 1. Buat repository
1. github.com → **New repository** → nama bebas (mis. `tiktok-live-tracker`) → **Public**.
   - Harus public supaya menit GitHub Actions gratis tanpa batas. Repo private cuma dapat 2.000 menit/bulan dan cron 10 menit menghabiskannya dalam ±2 minggu.
2. Upload semua file di folder ini (pertahankan struktur folder, termasuk `.github/workflows/`).
   - Cara cepat: **Add file → Upload files**, drag seluruh isi folder. Pastikan folder `.github` ikut (di macOS file/folder berawalan titik tersembunyi; tekan `Cmd+Shift+.` di Finder).
3. Edit `data/config.json`, isi `target_username` (tanpa `@`), lalu commit.

### 2. Izin workflow
**Settings → Actions → General → Workflow permissions** → pilih **Read and write permissions** → Save.

### 3. GitHub Pages
**Settings → Pages → Build and deployment** → Source: **Deploy from a branch** → Branch: `main`, folder: `/docs` → Save.
Dashboard tersedia di `https://<username-github>.github.io/<nama-repo>/` (±1-2 menit).

### 4. Personal Access Token (PAT) untuk dashboard
1. github.com → foto profil → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Token name: `live-tracker-dashboard`, Expiration: 90 hari (jangan "No expiration").
3. Repository access: **Only select repositories** → pilih repo ini saja.
4. Repository permissions:
   - **Contents: Read and write** (simpan config, baca histori & status live)
   - **Actions: Read and write** (tombol "Cek Sekarang")
   - Metadata: Read-only (otomatis)
5. Generate → salin token → buka dashboard → **Pengaturan** → tempel → **Simpan & Tes Koneksi**.

Token hanya disimpan di localStorage browser itu. Jangan dipakai di komputer bersama.

### 5. Tes pertama
**Actions → Monitor TikTok Live → Run workflow**. Kalau target offline, log menulis "offline" dan run selesai ±30 detik. Saat target live, data muncul di dashboard ±2-3 menit setelah run mulai.

### Opsional
- Secret `EULER_API_KEY` (Settings → Secrets and variables → Actions): API key gratis/berbayar dari eulerstream.com untuk sign server TikTok-Live-Connector kalau sering kena rate limit.
- Variable `TT_CONNECT_WITH_UNIQUE_ID` = `true`: aktifkan kalau log tracker sering gagal ambil Room ID (captcha di IP runner).

## Batasan yang perlu dipahami
- **Bukan real-time per detik.** Dashboard membaca snapshot yang dikirim runner tiap ±60 detik.
- **Deteksi live telat 10-25 menit.** Cron GitHub minimal 5 menit dan sering tertunda saat server ramai; awal live bisa tidak terekam. Durasi di laporan memakai waktu mulai live dari TikTok kalau tersedia.
- **Batas 1 run = 160 menit.** Live lebih lama otomatis disambung run berikutnya (jadi 2 sesi di histori).
- **Video dipecah per 20 menit** karena batas 2 GiB per file di Releases.
- **Repo public = semua file Releases bisa diunduh siapa pun**, termasuk rekaman live akun orang lain. Pertimbangkan hak cipta & ToS TikTok sebelum mengaktifkan auto record.
- Library TikTok-Live-Connector dan plugin Streamlink adalah hasil reverse engineering; kalau TikTok mengubah sistemnya, tracking/rekaman bisa berhenti sampai library di-update (`npm install` di workflow selalu ambil versi terbaru dalam range `^2`, Streamlink di-install versi terbaru tiap run).
