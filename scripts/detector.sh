#!/usr/bin/env bash
# =============================================================================
# TikTok Live Detector
# -----------------------------------------------------------------------------
# - Membaca daftar akun (maks 10) dari data/config.json (selalu versi terbaru via API).
# - Mengecek status live tiap akun pakai Streamlink, tiap SWEEP_INTERVAL_SEC detik,
#   selama DETECT_LOOP_MINUTES menit (0 = cek sekali lalu selesai).
# - Menulis status semua akun ke branch `live-status` (file status.json) -> dibaca dashboard.
# - Akun yang LIVE dan belum di-track  -> memicu workflow track_live.yml
# - record_target yang LIVE dan belum direkam -> memicu workflow record_live.yml
#
# Butuh env: GITHUB_TOKEN, GITHUB_REPOSITORY (otomatis di GitHub Actions)
# =============================================================================
set -uo pipefail

log() { echo "[detector $(TZ=Asia/Jakarta date '+%Y-%m-%d %H:%M:%S')] $*"; }

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
REPO="${GITHUB_REPOSITORY:-}"
API="${GITHUB_API_URL:-https://api.github.com}"
HOST="${GITHUB_SERVER_URL:-https://github.com}"; HOST="${HOST#https://}"; HOST="${HOST#http://}"
LOOP_MINUTES="${DETECT_LOOP_MINUTES:-50}"
SWEEP="${SWEEP_INTERVAL_SEC:-90}"
STATUS_BRANCH="${LIVE_STATUS_BRANCH:-live-status}"
MAX_ACCOUNTS=10
DISPATCH_COOLDOWN=600   # detik; jeda minimal memicu ulang tracker/recorder akun yang sama

if [[ -z "$TOKEN" || -z "$REPO" ]]; then
  log "ERROR: GITHUB_TOKEN dan GITHUB_REPOSITORY wajib ada."
  exit 1
fi
export GH_TOKEN="$TOKEN" GH_REPO="$REPO"

for bin in streamlink jq gh git curl; do
  command -v "$bin" >/dev/null 2>&1 || { log "ERROR: '$bin' tidak ditemukan."; exit 1; }
done

STATUS_DIR="$(mktemp -d)"
git -C "$STATUS_DIR" init -q
git -C "$STATUS_DIR" config user.name "github-actions[bot]"
git -C "$STATUS_DIR" config user.email "41898283+github-actions[bot]@users.noreply.github.com"
git -C "$STATUS_DIR" remote add origin "${STATUS_REMOTE_URL:-https://x-access-token:${TOKEN}@${HOST}/${REPO}.git}"
git -C "$STATUS_DIR" checkout -q --orphan "$STATUS_BRANCH"
HAS_COMMIT=0

declare -A LAST_TRACK_DISPATCH=()
declare -A LAST_REC_DISPATCH=()
declare -A LIVE_SINCE=()

read_config() {
  local cfg
  cfg="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw+json" \
        "$API/repos/$REPO/contents/data/config.json" 2>/dev/null)" || cfg=""
  if [[ -z "$cfg" ]] || ! echo "$cfg" | jq -e . >/dev/null 2>&1; then
    cfg="$(cat data/config.json 2>/dev/null || echo '{}')"
  fi
  echo "$cfg"
}

# Daftar akun: normalisasi, buang duplikat (urutan dipertahankan), maks 10.
# Kompatibel dengan config lama (target_username).
parse_accounts() {
  jq -r --argjson max "$MAX_ACCOUNTS" '
    [ ((.accounts // []) + (if (.target_username // "") != "" then [.target_username] else [] end))[]
      | tostring | ascii_downcase | ltrimstr("@") | gsub("\\s"; "")
      | select(test("^[a-z0-9._]{2,24}$")) | select(. != "username_target") ] as $a
    | [ range(0; $a | length) as $i | $a[$i] as $x | select(($a[:$i] | index([$x])) == null) | $x ]
    | .[:$max] | .[]'
}

# Output: "live" | "offline" | "error:<pesan>"
check_live() {
  local user="$1" out err
  out="$(timeout 45 streamlink --json "https://www.tiktok.com/@${user}/live" 2>/dev/null || true)"
  if echo "$out" | jq -e '(.streams // {}) | length > 0' >/dev/null 2>&1; then
    echo "live"; return
  fi
  err="$(echo "$out" | jq -r '.error // empty' 2>/dev/null || true)"
  if [[ -z "$out" ]]; then
    echo "error:timeout / tidak ada respons"
  elif [[ -z "$err" || "$err" =~ [Nn]o\ playable\ streams || "$err" =~ [Oo]ffline ]]; then
    echo "offline"
  else
    echo "error:${err:0:160}"
  fi
}

# Username yang sedang punya run aktif (queued / in_progress) untuk workflow tertentu.
active_users() {
  gh run list --workflow "$1" --limit 100 --json status,displayTitle \
    -q '.[] | select(.status != "completed") | .displayTitle' 2>/dev/null \
    | sed -n 's/.*@\([a-z0-9._]*\).*/\1/p' | sort -u
}

push_status() {
  local file="$STATUS_DIR/status.json"
  cp "$1" "$file"
  git -C "$STATUS_DIR" add status.json
  if (( HAS_COMMIT )); then
    git -C "$STATUS_DIR" commit -q --amend -m "status $(date -u +%FT%TZ)"
  else
    git -C "$STATUS_DIR" commit -q -m "status $(date -u +%FT%TZ)" && HAS_COMMIT=1
  fi
  if ! git -C "$STATUS_DIR" push -q -f origin "HEAD:refs/heads/${STATUS_BRANCH}" 2>/dev/null; then
    log "PERINGATAN: push status gagal."
  fi
}

START=$(date +%s)
END=$(( START + LOOP_MINUTES * 60 ))
SWEEP_NO=0
log "Mulai. Loop ${LOOP_MINUTES} menit, cek tiap ${SWEEP} detik."

while :; do
  SWEEP_NO=$((SWEEP_NO + 1))
  SWEEP_START=$(date +%s)
  CFG="$(read_config)"
  mapfile -t ACCOUNTS < <(echo "$CFG" | parse_accounts)
  RECORD_TARGET="$(echo "$CFG" | jq -r '(.record_target // "") | ascii_downcase | ltrimstr("@")')"
  AUTO_REC="$(echo "$CFG" | jq -r 'if .auto_record_enabled == false then "false" else "true" end')"

  mapfile -t TRACKING < <(active_users track_live.yml)
  mapfile -t RECORDING < <(active_users record_live.yml)

  # Tahap 1: cek semua akun pakai Streamlink
  declare -A RESULT=()
  declare -A SOURCE=()
  NOT_LIVE=()
  for u in "${ACCOUNTS[@]}"; do
    RESULT[$u]="$(check_live "$u")"
    SOURCE[$u]="streamlink"
    [[ "${RESULT[$u]}" != "live" ]] && NOT_LIVE+=("$u")
  done

  # Tahap 2: cek ulang akun yang tidak live pakai TikTok-Live-Connector
  # (Streamlink kadang gagal membaca halaman live tertentu)
  if (( ${#NOT_LIVE[@]} > 0 )) && [[ -f scripts/check_live.js && -d node_modules/tiktok-live-connector ]]; then
    FB="$(timeout 120 node scripts/check_live.js "${NOT_LIVE[@]}" 2>/dev/null | tail -n 1)"
    if echo "$FB" | jq -e 'type == "object"' >/dev/null 2>&1; then
      for u in "${NOT_LIVE[@]}"; do
        fb="$(echo "$FB" | jq -r --arg u "$u" '.[$u] // empty')"
        if [[ "$fb" == "live" ]]; then
          log "@$u: Streamlink bilang '${RESULT[$u]%%:*}', TikTok-Live-Connector bilang LIVE -> dianggap live."
          RESULT[$u]="live"; SOURCE[$u]="connector"
        elif [[ "$fb" == "offline" && "${RESULT[$u]}" == error:* ]]; then
          RESULT[$u]="offline"; SOURCE[$u]="connector"
        fi
      done
    else
      log "PERINGATAN: cek cadangan (check_live.js) tidak memberi hasil."
    fi
  fi

  ROWS="$(mktemp)"
  for u in "${ACCOUNTS[@]}"; do
    res="${RESULT[$u]}"
    now_iso="$(date -u +%FT%TZ)"
    state="${res%%:*}"
    errmsg=""
    [[ "$state" == "error" ]] && errmsg="${res#error:}"

    if [[ "$state" == "live" ]]; then
      [[ -z "${LIVE_SINCE[$u]:-}" ]] && LIVE_SINCE[$u]="$now_iso"
    elif [[ "$state" == "offline" ]]; then
      unset "LIVE_SINCE[$u]"
    fi

    is_tracking=false; is_recording=false
    printf '%s\n' "${TRACKING[@]:-}" | grep -qx "$u" && is_tracking=true
    printf '%s\n' "${RECORDING[@]:-}" | grep -qx "$u" && is_recording=true

    # Picu tracker
    if [[ "$state" == "live" && "$is_tracking" == "false" ]]; then
      last="${LAST_TRACK_DISPATCH[$u]:-0}"
      if (( $(date +%s) - last >= DISPATCH_COOLDOWN )); then
        if gh workflow run track_live.yml -f username="$u" >/dev/null 2>&1; then
          LAST_TRACK_DISPATCH[$u]=$(date +%s); is_tracking=true
          log "@$u LIVE -> tracker dipicu."
        else
          log "PERINGATAN: gagal memicu tracker @$u (cek permissions actions: write)."
        fi
      fi
    fi

    # Picu recorder (hanya 1 akun: record_target)
    if [[ "$AUTO_REC" == "true" && "$u" == "$RECORD_TARGET" && "$state" == "live" && "$is_recording" == "false" ]]; then
      last="${LAST_REC_DISPATCH[$u]:-0}"
      if (( $(date +%s) - last >= DISPATCH_COOLDOWN )); then
        if gh workflow run record_live.yml -f username="$u" >/dev/null 2>&1; then
          LAST_REC_DISPATCH[$u]=$(date +%s); is_recording=true
          log "@$u LIVE -> recorder dipicu."
        else
          log "PERINGATAN: gagal memicu recorder @$u."
        fi
      fi
    fi

    jq -cn --arg u "$u" --arg s "$state" --arg e "$errmsg" --arg t "$now_iso" --arg src "${SOURCE[$u]}" \
      --arg since "${LIVE_SINCE[$u]:-}" --argjson tr "$is_tracking" --argjson rc "$is_recording" \
      '{username:$u, live:($s=="live"), state:$s, error:(if $e=="" then null else $e end),
        checked_at:$t, live_since:(if $since=="" then null else $since end),
        tracking:$tr, recording:$rc, source:$src}' >> "$ROWS"
    log "@$u: $state${errmsg:+ ($errmsg)}$([[ $is_tracking == true ]] && echo ' [tracking]')$([[ $is_recording == true ]] && echo ' [recording]')"
  done

  NEXT_AT="$(date -u -d "@$(( SWEEP_START + SWEEP ))" +%FT%TZ)"
  STATUS_JSON="$(mktemp)"
  jq -s --arg t "$(date -u +%FT%TZ)" --arg next "$NEXT_AT" --argjson iv "$SWEEP" \
     --arg rt "$RECORD_TARGET" --argjson ar "$([[ $AUTO_REC == true ]] && echo true || echo false)" \
     --argjson loop "$([[ $LOOP_MINUTES -gt 0 ]] && echo true || echo false)" \
     '{updated_at:$t, next_check_at:$next, sweep_interval_sec:$iv, loop_mode:$loop,
       record_target:$rt, auto_record_enabled:$ar,
       accounts:(map({key:.username, value:.}) | from_entries)}' "$ROWS" > "$STATUS_JSON"
  push_status "$STATUS_JSON"
  rm -f "$ROWS" "$STATUS_JSON"

  if (( LOOP_MINUTES <= 0 )); then break; fi
  NOW=$(date +%s)
  (( NOW + SWEEP >= END )) && break
  SLEEP_FOR=$(( SWEEP_START + SWEEP - NOW ))
  (( SLEEP_FOR > 0 )) && sleep "$SLEEP_FOR"
done

log "Selesai setelah ${SWEEP_NO} putaran cek."
exit 0
