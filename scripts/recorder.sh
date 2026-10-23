#!/usr/bin/env bash
# =============================================================================
# TikTok Live Auto-Recorder (hanya 1 akun aktif)
# -----------------------------------------------------------------------------
# Pemakaian : bash scripts/recorder.sh <username> [output_dir]
# Output    : <output_dir>/Live_<username>_<timestamp>.mp4
#             (kalau live panjang: ..._part01.mp4, _part02.mp4, ...)
#
# Aturan "1 akun aktif":
#   - Sebelum mulai, cek data/config.json: username harus = record_target
#     dan auto_record_enabled = true. Kalau tidak, exit tanpa merekam.
#   - Selama merekam, config dicek ulang tiap 60 detik. Kalau record_target
#     diganti / auto record dimatikan, rekaman dihentikan rapi lalu di-upload.
#
# Kenapa dipecah per part? Batas 1 file di GitHub Releases = 2 GiB.
#
# Environment (opsional):
#   MAX_LIVE_MINUTES=160, SEGMENT_SECONDS=1200, SESSION_STAMP, RECORD_DIR=recordings
#   GITHUB_TOKEN + GITHUB_REPOSITORY -> dipakai untuk membaca config terbaru
#   SKIP_CONFIG_CHECK=true           -> abaikan cek record_target (tes lokal)
# =============================================================================
set -uo pipefail

log() { echo "[recorder $(TZ=Asia/Jakarta date '+%Y-%m-%d %H:%M:%S')] $*"; }

USERNAME_RAW="${1:-}"
if [[ -z "$USERNAME_RAW" ]]; then
  echo "Pemakaian: $0 <username> [output_dir]"
  exit 1
fi

USERNAME="$(echo "${USERNAME_RAW#@}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if ! [[ "$USERNAME" =~ ^[a-z0-9._]{2,24}$ ]]; then
  log "Username \"$USERNAME\" tidak valid. Exit."
  exit 1
fi

OUT_DIR="${2:-${RECORD_DIR:-recordings}}"
MAX_MINUTES="${MAX_LIVE_MINUTES:-160}"
SEGMENT_SECONDS="${SEGMENT_SECONDS:-1200}"
STAMP="${SESSION_STAMP:-$(TZ=Asia/Jakarta date +%Y%m%d_%H%M%S)}"
URL="https://www.tiktok.com/@${USERNAME}/live"
BASENAME="Live_${USERNAME}_${STAMP}"
TMP_DIR="${OUT_DIR}/.tmp_${STAMP}"

for bin in streamlink ffmpeg jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "ERROR: '$bin' tidak ditemukan di PATH."
    exit 1
  fi
done

mkdir -p "$OUT_DIR"

# -----------------------------------------------------------------------------
# 0) Pastikan akun ini memang record_target yang aktif
# -----------------------------------------------------------------------------
API="${GITHUB_API_URL:-https://api.github.com}"
read_config() {
  local cfg=""
  if [[ -n "${GITHUB_TOKEN:-}" && -n "${GITHUB_REPOSITORY:-}" ]]; then
    cfg="$(curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw+json" \
          "$API/repos/$GITHUB_REPOSITORY/contents/data/config.json" 2>/dev/null)" || cfg=""
  fi
  if [[ -z "$cfg" ]] || ! echo "$cfg" | jq -e . >/dev/null 2>&1; then
    cfg="$(cat data/config.json 2>/dev/null || echo '{}')"
  fi
  echo "$cfg"
}
# return 0 kalau akun ini masih boleh direkam
still_allowed() {
  [[ "${SKIP_CONFIG_CHECK:-false}" == "true" ]] && return 0
  local cfg target auto
  cfg="$(read_config)"
  target="$(echo "$cfg" | jq -r '(.record_target // "") | ascii_downcase | ltrimstr("@")')"
  auto="$(echo "$cfg" | jq -r 'if .auto_record_enabled == false then "false" else "true" end')"
  [[ "$auto" == "true" && "$target" == "$USERNAME" ]]
}

if ! still_allowed; then
  log "@${USERNAME} bukan record_target aktif (atau auto record OFF). Tidak merekam."
  exit 0
fi

# -----------------------------------------------------------------------------
# Jalur cadangan: URL stream langsung dari data room TikTok (TikTok-Live-Connector)
# -----------------------------------------------------------------------------
get_direct_url() {
  [[ -f scripts/stream_url.js && -d node_modules/tiktok-live-connector ]] || return 1
  timeout 60 node scripts/stream_url.js "$USERNAME" 2>>"${OUT_DIR}/.recorder_debug.log" | tail -n 1
}

# -----------------------------------------------------------------------------
# 1) Cek status live (Streamlink, lalu cadangan URL langsung)
# -----------------------------------------------------------------------------
# Cari stream. Kalau belum ketemu, coba lagi tiap 60 detik selama RECORD_WAIT_MINUTES
# (stream kadang belum tersedia di menit-menit awal live / sumber data sedang error).
WAIT_MIN="${RECORD_WAIT_MINUTES:-10}"
FIND_DEADLINE=$(( $(date +%s) + WAIT_MIN * 60 ))
SL_OK=false
DIRECT_URL=""
TRY=0
while :; do
  TRY=$((TRY + 1))
  log "Cari stream @${USERNAME} (percobaan ${TRY}) ..."
  STREAMS_JSON="$(streamlink --json "$URL" 2>>"${OUT_DIR}/.recorder_debug.log" || true)"
  if echo "$STREAMS_JSON" | jq -e '(.streams // {}) | length > 0' >/dev/null 2>&1; then
    SL_OK=true
    log "Streamlink: stream ditemukan. Kualitas: $(echo "$STREAMS_JSON" | jq -r '.streams | keys | join(", ")')"
    break
  fi
  log "Streamlink tidak menemukan stream: $(echo "$STREAMS_JSON" | jq -r '.error // "tanpa pesan"' 2>/dev/null)"

  DIRECT_URL="$(get_direct_url || true)"
  if [[ -n "$DIRECT_URL" ]]; then
    log "Cadangan: URL stream langsung ditemukan, rekam pakai FFmpeg."
    break
  fi
  log "Cadangan juga tidak menemukan URL stream (detail per sumber ada di laporan Summary)."

  if ! still_allowed; then log "record_target berubah, berhenti."; exit 0; fi
  if (( $(date +%s) + 60 > FIND_DEADLINE )); then
    log "GAGAL: ${WAIT_MIN} menit tidak menemukan stream yang bisa direkam."
    exit 4
  fi
  sleep 60
done

# -----------------------------------------------------------------------------
# 2) Rekam. Ditulis sebagai segmen .ts (tahan crash), maks MAX_MINUTES total.
#    Kalau satu metode gagal (data < 1 MB), otomatis pindah ke metode lain.
# -----------------------------------------------------------------------------
mkdir -p "$TMP_DIR"
STOP_FLAG="${TMP_DIR}/.stopped_by_config"
DEADLINE=$(( $(date +%s) + MAX_MINUTES * 60 ))
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

# Watcher: hentikan rekaman kalau record_target diganti / auto record dimatikan
(
  while sleep "${RECORD_WATCH_SEC:-60}"; do
    if ! still_allowed; then
      touch "$STOP_FLAG"
      log "record_target berubah / auto record OFF -> hentikan rekaman @${USERNAME}."
      pkill -INT -f "streamlink.*tiktok\.com/@${USERNAME}/live" 2>/dev/null || true
      pkill -INT -f "ffmpeg.*rec_${USERNAME}_" 2>/dev/null || true
      break
    fi
  done
) &
WATCHER_PID=$!

record_streamlink() {   # $1 = prefix file, $2 = sisa detik
  timeout --signal=INT --kill-after=60 "$2" \
    streamlink "$URL" best --retry-streams 10 --retry-max 3 --stream-timeout 30 --stdout --loglevel info \
      2>>"${OUT_DIR}/.recorder_debug.log" \
  | ffmpeg -hide_banner -loglevel warning -nostdin -i pipe:0 \
      -map '0:v?' -map '0:a?' -c copy \
      -f segment -segment_time "$SEGMENT_SECONDS" -segment_format mpegts -reset_timestamps 1 \
      "$1_seg%03d.ts"
  local st=("${PIPESTATUS[@]}")
  log "  streamlink exit=${st[0]}, ffmpeg exit=${st[1]}"
}

record_direct() {       # $1 = prefix file, $2 = sisa detik, $3 = URL
  # nama output memuat "rec_<user>_" supaya watcher bisa menghentikannya
  timeout --signal=INT --kill-after=60 "$2" \
    ffmpeg -hide_banner -loglevel warning -nostdin \
      -user_agent "$UA" -headers $'Referer: https://www.tiktok.com/\r\n' \
      -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -rw_timeout 30000000 \
      -i "$3" -map '0:v?' -map '0:a?' -c copy \
      -f segment -segment_time "$SEGMENT_SECONDS" -segment_format mpegts -reset_timestamps 1 \
      "$1_seg%03d.ts" 2>>"${OUT_DIR}/.recorder_debug.log"
  log "  ffmpeg (URL langsung) exit=$?"
}

bytes_of() { local t=0 f; for f in "$1"_seg*.ts; do [[ -f "$f" ]] && t=$(( t + $(stat -c%s "$f") )); done; echo "$t"; }

shopt -s nullglob
METHOD="streamlink"; [[ "$SL_OK" == "false" ]] && METHOD="direct"
ATTEMPT=0
while (( ATTEMPT < 4 )); do
  ATTEMPT=$((ATTEMPT + 1))
  REMAIN=$(( DEADLINE - $(date +%s) ))
  (( REMAIN < 30 )) && { log "Batas waktu rekam tercapai."; break; }
  [[ -f "$STOP_FLAG" ]] && break
  PREFIX="${TMP_DIR}/rec_${USERNAME}_a${ATTEMPT}"

  log "Percobaan ${ATTEMPT}: rekam pakai ${METHOD} (sisa waktu $((REMAIN / 60)) menit) ..."
  if [[ "$METHOD" == "streamlink" ]]; then
    record_streamlink "$PREFIX" "$REMAIN"
  else
    [[ -z "$DIRECT_URL" ]] && DIRECT_URL="$(get_direct_url || true)"
    if [[ -z "$DIRECT_URL" ]]; then log "  URL langsung tidak tersedia."; break; fi
    record_direct "$PREFIX" "$REMAIN" "$DIRECT_URL"
    DIRECT_URL=""   # URL bisa kedaluwarsa; ambil baru di percobaan berikutnya
  fi

  GOT=$(bytes_of "$PREFIX")
  log "  Data terekam di percobaan ini: $(( GOT / 1024 )) KB"
  [[ -f "$STOP_FLAG" ]] && break

  # Live masih jalan? (cek ulang singkat)
  STILL_LIVE=false
  if streamlink --json "$URL" 2>/dev/null | jq -e '(.streams // {}) | length > 0' >/dev/null 2>&1; then STILL_LIVE=true
  elif [[ -n "$(get_direct_url || true)" ]]; then STILL_LIVE=true; fi
  if [[ "$STILL_LIVE" == "false" ]]; then log "Live sudah selesai."; break; fi

  # Masih live tapi metode ini gagal / terputus -> coba metode lain
  if (( GOT < 1048576 )); then
    if [[ "$METHOD" == "streamlink" ]]; then METHOD="direct"; else METHOD="streamlink"; fi
    log "  Metode sebelumnya gagal, pindah ke ${METHOD}."
  else
    log "  Rekaman terputus padahal masih live, sambung lagi."
  fi
  sleep 5
done

kill "$WATCHER_PID" 2>/dev/null || true
wait "$WATCHER_PID" 2>/dev/null || true
[[ -f "$STOP_FLAG" ]] && log "Rekaman dihentikan karena perubahan config." && rm -f "$STOP_FLAG"

# -----------------------------------------------------------------------------
# 3) Remux .ts -> .mp4 (tanpa re-encode)
# -----------------------------------------------------------------------------
# buang segmen kosong/sangat kecil (< 50 KB)
for ts in "${TMP_DIR}"/*.ts; do
  if (( $(stat -c%s "$ts") < 51200 )); then
    log "Segmen terlalu kecil dibuang: $(basename "$ts") ($(stat -c%s "$ts") byte)"
    rm -f "$ts"
  fi
done

PARTS=("${TMP_DIR}"/*.ts)
TOTAL=${#PARTS[@]}
if (( TOTAL == 0 )); then
  log "GAGAL: tidak ada data video yang terekam. Detail error ada di ${OUT_DIR}/.recorder_debug.log"
  rm -rf "$TMP_DIR"
  exit 3
fi

IDX=0
for ts in "${PARTS[@]}"; do
  IDX=$((IDX + 1))
  if (( TOTAL == 1 )); then
    OUT_FILE="${OUT_DIR}/${BASENAME}.mp4"
  else
    OUT_FILE="${OUT_DIR}/${BASENAME}_part$(printf '%02d' "$IDX").mp4"
  fi

  if ffmpeg -hide_banner -loglevel error -nostdin -y \
       -i "$ts" -map 0 -c copy -movflags +faststart "$OUT_FILE"; then
    rm -f "$ts"
    log "OK: $(basename "$OUT_FILE") ($(du -h "$OUT_FILE" | cut -f1))"
  else
    log "Remux gagal untuk $(basename "$ts"), file .ts dipertahankan."
    rm -f "$OUT_FILE"
    mv "$ts" "${OUT_DIR}/"
  fi
done

rmdir "$TMP_DIR" 2>/dev/null || true

# peringatan kalau ada file mendekati batas 2 GiB GitHub Releases
for f in "${OUT_DIR}"/"${BASENAME}"*; do
  SIZE=$(stat -c%s "$f")
  if (( SIZE > 2000000000 )); then
    log "PERINGATAN: $(basename "$f") > 2 GB, upload ke Releases akan gagal. Kecilkan SEGMENT_SECONDS."
  fi
done

log "Selesai. File di folder ${OUT_DIR}/"
exit 0
