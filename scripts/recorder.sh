#!/usr/bin/env bash
# =============================================================================
# TikTok Live Auto-Recorder
# -----------------------------------------------------------------------------
# Pemakaian : bash scripts/recorder.sh <username> [output_dir]
# Output    : <output_dir>/Live_<username>_<timestamp>.mp4
#             (kalau live panjang: Live_<username>_<timestamp>_part01.mp4, _part02.mp4, ...)
#
# Kenapa dipecah per part?
#   Batas 1 file di GitHub Releases = 2 GiB. Live 2 jam di kualitas "best" bisa > 2 GB.
#   Rekaman ditulis sebagai segmen .ts (tahan crash/timeout), lalu di-remux ke .mp4
#   tanpa re-encode (cepat, kualitas tidak turun).
#
# Environment (opsional):
#   MAX_LIVE_MINUTES=160   batas lama rekam per run (harus < timeout job)
#   SEGMENT_SECONDS=1200   panjang 1 part (detik), default 20 menit
#   SESSION_STAMP=...      timestamp sesi (disamakan dengan tracker)
#   RECORD_DIR=recordings  folder output kalau argumen ke-2 kosong
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
