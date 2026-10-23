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
# 1) Cek status live
# -----------------------------------------------------------------------------
log "Cek status live @${USERNAME} ..."
STREAMS_JSON="$(streamlink --json "$URL" 2>/dev/null || true)"
if ! echo "$STREAMS_JSON" | jq -e '(.streams // {}) | length > 0' >/dev/null 2>&1; then
  ERR_MSG="$(echo "$STREAMS_JSON" | jq -r '.error // empty' 2>/dev/null || true)"
  log "Akun sedang offline${ERR_MSG:+ ($ERR_MSG)}"
  exit 0
fi
log "LIVE terdeteksi. Kualitas tersedia: $(echo "$STREAMS_JSON" | jq -r '.streams | keys | join(", ")')"

# -----------------------------------------------------------------------------
# 2) Rekam: streamlink -> stdout -> ffmpeg segmenter (.ts)
#    timeout kirim SIGINT ke streamlink supaya ffmpeg menutup segmen terakhir dengan rapi.
# -----------------------------------------------------------------------------
mkdir -p "$TMP_DIR"
STOP_FLAG="${TMP_DIR}/.stopped_by_config"

# Watcher: hentikan rekaman kalau record_target diganti / auto record dimatikan
(
  while sleep "${RECORD_WATCH_SEC:-60}"; do
    if ! still_allowed; then
      touch "$STOP_FLAG"
      log "record_target berubah / auto record OFF -> hentikan rekaman @${USERNAME}."
      pkill -INT -f "streamlink.*tiktok\.com/@${USERNAME}/live" 2>/dev/null || true
      break
    fi
  done
) &
WATCHER_PID=$!

log "Mulai rekam (maks ${MAX_MINUTES} menit, 1 part = ${SEGMENT_SECONDS} detik) ..."

timeout --signal=INT --kill-after=60 "${MAX_MINUTES}m" \
  streamlink "$URL" best \
    --retry-streams 10 \
    --retry-max 3 \
    --stream-timeout 30 \
    --stdout \
    --loglevel warning \
| ffmpeg -hide_banner -loglevel warning -nostdin \
    -i pipe:0 \
    -map '0:v?' -map '0:a?' -c copy \
    -f segment -segment_time "$SEGMENT_SECONDS" -segment_format mpegts -reset_timestamps 1 \
    "${TMP_DIR}/${BASENAME}_seg%03d.ts"

PIPE_STATUS=("${PIPESTATUS[@]}")
kill "$WATCHER_PID" 2>/dev/null || true
wait "$WATCHER_PID" 2>/dev/null || true
[[ -f "$STOP_FLAG" ]] && log "Rekaman dihentikan karena perubahan config." && rm -f "$STOP_FLAG"
log "Rekaman berhenti (streamlink exit=${PIPE_STATUS[0]}, ffmpeg exit=${PIPE_STATUS[1]})."

# -----------------------------------------------------------------------------
# 3) Remux .ts -> .mp4 (tanpa re-encode)
# -----------------------------------------------------------------------------
shopt -s nullglob

# buang segmen sangat kecil (< 200 KB), biasanya sisa koneksi putus
for ts in "${TMP_DIR}"/*.ts; do
  if (( $(stat -c%s "$ts") < 204800 )); then
    rm -f "$ts"
  fi
done

PARTS=("${TMP_DIR}"/*.ts)
TOTAL=${#PARTS[@]}
if (( TOTAL == 0 )); then
  log "Tidak ada data video yang terekam (stream mungkin langsung berhenti)."
  rm -rf "$TMP_DIR"
  exit 0
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
