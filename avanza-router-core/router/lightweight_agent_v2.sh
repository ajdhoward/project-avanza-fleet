#!/bin/sh
# ============================================================================
# PROJECT AVANZA — avanza-router-core / router/lightweight_agent_v2.sh
# Host:   TP-Link Archer C7 v5 (ath79 / QCA9558, MIPS 74Kc, 128MB RAM,
#         OpenWrt 25.12.6, 7.1GB USB extroot)
# Role:   resident memory-loop telemetry + control agent. Samples
#         /proc/meminfo, /proc/net/nf_conntrack, plcstat (open-plc-utils),
#         usteer/hostapd association state; pushes HMAC-signed payloads to
#         the Cloudflare Worker bridge; polls the CommandLane; applies GitOps
#         fleet bundles under a strict 10-minute automated rollback safety
#         matrix (local gateway pings + independent Cloudflare health check).
#
# RAM budget: single-threaded short-lived child processes only, streaming
#         /proc readers, capped JSON buffers, no resident interpreters.
#
# Subcommands:
#   run                 main agent loop (procd-managed)
#   install ENDPOINT DEVICE_ID KEY64   provision env/secret/init/cron
#   watchdog            crond helper: relight the agent if dead
#   boot-recover        crond @reboot: enforce pending rollback after boot
# ============================================================================
set -u

AV_DIR="/etc/avanza"
AV_ENV="${AV_DIR}/agent.env"
AV_SECRET="${AV_DIR}/secret.key"
AV_BACKUPS="${AV_DIR}/backups"
AV_PENDING="${AV_DIR}/rollback.pending"
AV_GRANTS="${AV_DIR}/guest_grants"
AV_LOG_TAG="avanza-agent"

# Defaults (overridable via ${AV_ENV})
ENDPOINT_URL=""
DEVICE_ID="avanza-core"
TELEMETRY_INTERVAL="60"
PLC_IFACE=""
MEM_GUARD_KB="10240"
ROLLBACK_WINDOW="600"
GW_OVERRIDE=""
ENABLE_SPEEDTEST="0"
SPEEDTEST_INTERVAL="21600"
SPEEDTEST_PAYLOAD_BYTES="5242880"
ENABLE_GUEST_SAMPLING="0"
GUEST_IFACES=""
CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"

SECRET_KEY=""
FAIL_STREAK="0"

log() {
  logger -t "$AV_LOG_TAG" -p daemon.info -- "$*" 2>/dev/null || printf '[%s] %s\n' "$(date '+%T')" "$*"
}

warn() {
  logger -t "$AV_LOG_TAG" -p daemon.warning -- "$*" 2>/dev/null || printf '[%s] %s\n' "$(date '+%T')" "$*"
}

die() {
  logger -t "$AV_LOG_TAG" -p daemon.err -- "$*" 2>/dev/null || printf '[%s] %s\n' "$(date '+%T')" "$*"
  exit 1
}

load_env() {
  [ -r "$AV_ENV" ] || die "missing ${AV_ENV}; run 'install' first"
  # shellcheck disable=SC1090
  . "$AV_ENV"
  [ -r "$AV_SECRET" ] || die "missing ${AV_SECRET}"
  SECRET_KEY="$(tr -cd '0-9a-f' < "$AV_SECRET" 2>/dev/null || printf '')"
  [ "${#SECRET_KEY}" -ge 32 ] || die "secret key too short or unreadable"
  [ -n "$ENDPOINT_URL" ] || die "ENDPOINT_URL not configured"
  [ -n "$DEVICE_ID" ] || die "DEVICE_ID not configured"
  TELEMETRY_INTERVAL="$(num_or "$TELEMETRY_INTERVAL" 60)"
  ROLLBACK_WINDOW="$(num_or "$ROLLBACK_WINDOW" 600)"
}

num_or() {
  case "${1:-}" in
    ''|*[!0-9.]*) printf '%s' "$2" ;;
    *) printf '%s' "$1" ;;
  esac
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\001-\037'
}

timestamp_ms() {
  # epoch seconds padded to milliseconds (busybox date has no %N)
  printf '%s000' "$(date +%s)"
}

uptime_now() {
  awk '{print $1}' /proc/uptime 2>/dev/null || printf '0'
}

# ---------------------------------------------------------------------------
# Single-instance lock (busybox flock preferred, mkdir fallback)
# ---------------------------------------------------------------------------
acquire_lock() {
  if command -v flock >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    exec 9>/var/run/avanza-agent.lock
    flock -n 9 || exit 0
    return 0
  fi
  if mkdir /var/run/avanza-agent.lock 2>/dev/null; then
    printf '%s\n' "$$" > /var/run/avanza-agent.lock/pid
    return 0
  fi
  _lockpid="$(cat /var/run/avanza-agent.lock/pid 2>/dev/null || printf '')"
  if [ -n "$_lockpid" ] && [ -d "/proc/${_lockpid}" ]; then
    exit 0
  fi
  rm -rf /var/run/avanza-agent.lock 2>/dev/null || true
  mkdir /var/run/avanza-agent.lock 2>/dev/null || exit 0
  printf '%s\n' "$$" > /var/run/avanza-agent.lock/pid
}

# ---------------------------------------------------------------------------
# HMAC-SHA256: openssl path + pure-busybox fallback. The key is consumed as
# raw ASCII bytes in BOTH paths (matching the server's TextEncoder-derived
# key), so signatures are identical regardless of which path executes.
# ---------------------------------------------------------------------------
hmac_sha256() {
  _h_key="$1"; _h_msg="$2"
  if command -v openssl >/dev/null 2>&1; then
    printf '%s' "$_h_msg" | openssl dgst -sha256 -hmac "$_h_key" 2>/dev/null | awk '{print $NF}'
    return 0
  fi
  _hmac_pure "$_h_key" "$_h_msg"
}

_hmac_xor_pad() {
  # $1 = key hex (128 chars), $2 = pad byte value (decimal).
  # XOR is implemented arithmetically: awk's "^" is exponentiation, and
  # bitwise builtins (xor/and) are not portable across awk implementations.
  awk -v k="$1" -v pad="$2" 'BEGIN {
    tbl = "0123456789abcdef";
    for (i = 1; i <= length(k); i += 2) {
      a = index(tbl, substr(k, i, 1)) - 1;
      b = index(tbl, substr(k, i + 1, 1)) - 1;
      v = a * 16 + b;
      r = 0; m = 1; x = v; y = pad;
      while (x > 0 || y > 0) {
        if (x % 2 != y % 2) r += m;
        x = int(x / 2); y = int(y / 2); m = m * 2;
      }
      printf "%02x", r;
    }
  }'
}

_hex2esc() {
  # hex (stdin) -> printf octal-escape format string on stdout.
  # Octal escapes (POSIX printf) emit true raw bytes in both busybox and
  # dash; awk "%c" is avoided because gawk renders values >127 as UTF-8.
  awk '{
    tbl = "0123456789abcdef";
    s = tolower($0);
    for (i = 1; i <= length(s); i += 2) {
      a = index(tbl, substr(s, i, 1)) - 1;
      b = index(tbl, substr(s, i + 1, 1)) - 1;
      printf "\\%03o", (a * 16 + b);
    }
  }'
}

_ascii2hex() {
  # stdin -> lowercase hex of the raw byte stream. Matches the server's
  # HMAC key derivation (TextEncoder over the secret string = raw bytes).
  if command -v od >/dev/null 2>&1; then
    od -An -tx1 -v | tr -d ' \n'
  elif command -v hexdump >/dev/null 2>&1; then
    hexdump -v -e '/1 "%02x"'
  else
    awk 'BEGIN {
      tbl = "";
      for (i = 32; i <= 126; i++) tbl[sprintf("%c", i)] = sprintf("%02x", i);
    }
    {
      s = $0;
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1);
        if (c in tbl) printf "%s", tbl[c];
      }
    }'
  fi
}

_hmac_pure() {
  _p_key="$1"; _p_msg="$2"
  _p_k="$(printf '%s' "$_p_key" | _ascii2hex)"
  while [ "${#_p_k}" -lt 128 ]; do
    _p_k="${_p_k}0"
  done
  _p_k="$(printf '%.128s' "$_p_k")"
  _p_ipad_esc="$(printf '%s' "$(_hmac_xor_pad "$_p_k" 54)" | _hex2esc)"
  _p_opad_esc="$(printf '%s' "$(_hmac_xor_pad "$_p_k" 92)" | _hex2esc)"
  _p_inner="$({ printf "$_p_ipad_esc"; printf '%s' "$_p_msg"; } | sha256sum | awk '{print $1}')"
  _p_inner_esc="$(printf '%s' "$_p_inner" | _hex2esc)"
  { printf "$_p_opad_esc"; printf "$_p_inner_esc"; } | sha256sum | awk '{print $1}'
}

# ---------------------------------------------------------------------------
# Transport: curl preferred (header-signed); uclient-fetch fallback signs via
# query params (server accepts both locations). TLS CA bundle honoured when
# present; the degraded mode is logged once, never silently.
# ---------------------------------------------------------------------------
_tls_flag_logged="0"

_fetch_tls_args() {
  _f_args=""
  if command -v curl >/dev/null 2>&1; then
    _f_args=""
  else
    if [ -f "$CA_BUNDLE" ]; then
      _f_args="--ca-certificate=${CA_BUNDLE}"
    else
      _f_args="--no-check-certificate"
      if [ "$_tls_flag_logged" = "0" ]; then
        warn "no CA bundle at ${CA_BUNDLE}: TLS verification degraded for uclient-fetch"
        _tls_flag_logged="1"
      fi
    fi
  fi
  printf '%s' "$_f_args"
}

http_post_json() {
  _t_url="$1"; _t_path="$2"; _t_payload="$3"
  _t_ts="$(date +%s)"
  _t_sig="$(hmac_sha256 "$SECRET_KEY" "${_t_ts}.${_t_payload}")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 20 \
      -H "Content-Type: application/json" \
      -H "X-Avanza-Timestamp: ${_t_ts}" \
      -H "X-Avanza-Signature: ${_t_sig}" \
      --data-binary "$_t_payload" \
      "${_t_url}${_t_path}" 2>/dev/null
    return $?
  fi
  _t_tls="$(printf '%s' "$(_fetch_tls_args)" | sed 's/--ca-certificate/--ca-certificate=/' )"
  # normalize: uclient-fetch wants --ca-certificate=FILE or --no-check-certificate
  case "$_t_tls" in
    --ca-certificate=*) _t_tls_args="$_t_tls" ;;
    "") _t_tls_args="" ;;
    *) _t_tls_args="$_t_tls" ;;
  esac
  _t_res="/tmp/avanza-res.$$"
  # shellcheck disable=SC2086
  uclient-fetch -q -O "$_t_res" --timeout=20 --post-data="$_t_payload" \
    ${_t_tls_args} \
    "${_t_url}${_t_path}?sig_ts=${_t_ts}&sig=${_t_sig}" >/dev/null 2>&1
  _t_rc=$?
  if [ -s "$_t_res" ]; then cat "$_t_res"; fi
  rm -f "$_t_res"
  return "$_t_rc"
}

http_get_signed() {
  _g_path="$1"; _g_query="$2"
  _g_ts="$(date +%s)"
  _g_canon="${_g_ts}.GET ${_g_path}"
  [ -n "$_g_query" ] && _g_canon="${_g_canon}?${_g_query}"
  _g_sig="$(hmac_sha256 "$SECRET_KEY" "$_g_canon")"
  _g_url="${ENDPOINT_URL}${_g_path}"
  if [ -n "$_g_query" ]; then
    _g_url="${_g_url}?${_g_query}&sig_ts=${_g_ts}&sig=${_g_sig}"
  else
    _g_url="${_g_url}?sig_ts=${_g_ts}&sig=${_g_sig}"
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 20 "${_g_url}" 2>/dev/null
    return $?
  fi
  _g_tls="$( _fetch_tls_args )"
  _g_res="/tmp/avanza-get.$$"
  # shellcheck disable=SC2086
  uclient-fetch -q -O "$_g_res" --timeout=20 ${_g_tls} "$_g_url" >/dev/null 2>&1
  _g_rc=$?
  if [ -s "$_g_res" ]; then cat "$_g_res"; fi
  rm -f "$_g_res"
  return "$_g_rc"
}

http_get_public() {
  _q_url="${ENDPOINT_URL}$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 15 "$_q_url" 2>/dev/null
    return $?
  fi
  _q_tls="$( _fetch_tls_args )"
  _q_res="/tmp/avanza-pub.$$"
  # shellcheck disable=SC2086
  uclient-fetch -q -O "$_q_res" --timeout=15 ${_q_tls} "$_q_url" >/dev/null 2>&1
  _q_rc=$?
  if [ -s "$_q_res" ]; then cat "$_q_res"; fi
  rm -f "$_q_res"
  return "$_q_rc"
}

# ---------------------------------------------------------------------------
# Memory-safe /proc readers (streaming, one pass, no full-table buffering)
# ---------------------------------------------------------------------------
mem_available_kb() {
  awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null || printf '0'
}

mem_total_kb() {
  awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null || printf '0'
}

conntrack_count() {
  _c_f="/proc/net/nf_conntrack"
  [ -r "$_c_f" ] || _c_f="/proc/net/ip_conntrack"
  if [ ! -r "$_c_f" ]; then
    printf '0'
    return 0
  fi
  wc -l < "$_c_f" | tr -d ' \t'
}

load1_value() {
  awk '{print $1}' /proc/loadavg 2>/dev/null || printf '0'
}

uptime_seconds() {
  awk '{print int($1)}' /proc/uptime 2>/dev/null || printf '0'
}

default_gateway() {
  if [ -n "$GW_OVERRIDE" ]; then
    printf '%s' "$GW_OVERRIDE"
    return 0
  fi
  route -n 2>/dev/null | awk '$1 == "0.0.0.0" {print $2; exit}'
}

# ---------------------------------------------------------------------------
# Powerline (HomePlug AV) sampling via open-plc-utils, strictly non-resident:
# one short-lived plcstat -t run per cycle, capped output, tolerant parser.
# ---------------------------------------------------------------------------
plc_sample() {
  PLC_PEERS=""
  PLC_TX="0"
  PLC_RX="0"
  command -v plcstat >/dev/null 2>&1 || return 0
  _p_iface="$PLC_IFACE"
  if [ -z "$_p_iface" ]; then
    _p_iface="$(awk '/^PLC=/{print $NF}' /etc/profile 2>/dev/null || printf 'eth1')"
  fi
  [ -n "$_p_iface" ] || return 0
  [ -e "/sys/class/net/${_p_iface}" ] || return 0
  _p_out=""
  if command -v timeout >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    _p_out="$(timeout 10 plcstat -i "$_p_iface" -t -q 2>/dev/null | head -c 8192)"
  else
    _p_out="$(plcstat -i "$_p_iface" -t -q 2>/dev/null | head -c 8192)"
  fi
  [ -n "$_p_out" ] || return 0
  _p_rows="$(_plc_parse "$_p_out")"
  [ -n "$_p_rows" ] || return 0
  _p_json=""
  _p_first="1"
  _p_best_rx="0"
  _p_best_tx="0"
  # rows are "mac,tx,rx" — no whitespace inside fields, safe to word-split
  # shellcheck disable=SC2086
  for _row in $_p_rows; do
    _mac="$(printf '%s' "$_row" | cut -d, -f1)"
    _tx="$(printf '%s' "$_row" | cut -d, -f2)"
    _rx="$(printf '%s' "$_row" | cut -d, -f3)"
    [ -n "$_mac" ] || continue
    if [ "$_p_first" = "1" ]; then _p_first="0"; else _p_json="${_p_json},"; fi
    _p_json="${_p_json}{\"peer_mac\":\"${_mac}\",\"tx_mbps\":${_tx:-0},\"rx_mbps\":${_rx:-0},\"iface\":\"$(json_escape "$_p_iface")\"}"
    case "$_rx" in ''|*[!0-9.]*) _rx="0";; esac
    case "$_tx" in ''|*[!0-9.]*) _tx="0";; esac
    if awk -v a="$_rx" -v b="$_p_best_rx" 'BEGIN{exit !(a>b)}'; then _p_best_rx="$_rx"; fi
    if awk -v a="$_tx" -v b="$_p_best_tx" 'BEGIN{exit !(a>b)}'; then _p_best_tx="$_tx"; fi
  done
  PLC_PEERS="$_p_json"
  PLC_TX="$_p_best_tx"
  PLC_RX="$_p_best_rx"
}

_plc_parse() {
  # Reads plcstat -t output; emits rows "mac,tx,rx" comma-separated so the
  # parent shell never has to word-split whitespace inside rates.
  awk '
    {
      lc = tolower($0);
      nf = split(lc, f, "[ \t]+");
      for (i = 1; i <= nf; i++) {
        if (f[i] ~ /^[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]$/) {
          mac = f[i];
        } else if (f[i] ~ /^tx/) {
          v = f[i]; sub(/^tx[=:]/, "", v);
          if (v == "" && i < nf) v = f[i + 1];
          gsub(/[^0-9.]/, "", v);
          if (v != "" && mac != "") tx[mac] = v;
        } else if (f[i] ~ /^rx/) {
          v = f[i]; sub(/^rx[=:]/, "", v);
          if (v == "" && i < nf) v = f[i + 1];
          gsub(/[^0-9.]/, "", v);
          if (v != "" && mac != "") rx[mac] = v;
        }
      }
    }
    END {
      for (m in tx) {
        if (!(m in rx)) rx[m] = 0;
        printf "%s,%s,%s\n", m, tx[m], rx[m];
      }
    }
  '
}

push_plc_links() {
  [ -n "$PLC_PEERS" ] || return 0
  _pl_payload="{\"kind\":\"plc_links\",\"device\":\"${DEVICE_ID}\",\"ts\":$(timestamp_ms),\"links\":[${PLC_PEERS}]}"
  if [ "${#_pl_payload}" -gt 12288 ]; then
    warn "plc payload exceeded cap; dropping cycle"
    return 0
  fi
  http_post_json "$ENDPOINT_URL" "/api/ingest" "$_pl_payload" >/dev/null 2>&1 || warn "plc_links ingest failed"
}

# ---------------------------------------------------------------------------
# Wireless association sampling: usteer aggregate first, per-BSS hostapd
# fallback (usteer steering engine runs on this core node per fleet design).
# ---------------------------------------------------------------------------
clients_sample() {
  CL_JSON=""
  command -v ubus >/dev/null 2>&1 || return 0
  _cl_tmp="/tmp/avanza-cl.$$"
  : > "$_cl_tmp"
  if ubus -S call usteer get_clients > "$_cl_tmp" 2>/dev/null && [ -s "$_cl_tmp" ]; then
    CL_JSON="$(head -c 6144 "$_cl_tmp")"
  else
    : > "$_cl_tmp"
    printf '{"ifaces":[' > "$_cl_tmp"
    _cl_first="1"
    for _cl_if in /sys/class/net/wlan*; do
      [ -e "$_cl_if" ] || continue
      _cl_name="$(basename "$_cl_if")"
      _cl_obj="/tmp/avanza-obj.$$"
      ubus -S call "hostapd.${_cl_name}" get_clients > "$_cl_obj" 2>/dev/null || { rm -f "$_cl_obj"; continue; }
      [ -s "$_cl_obj" ] || { rm -f "$_cl_obj"; continue; }
      if [ "$_cl_first" = "1" ]; then _cl_first="0"; else printf ',' >> "$_cl_tmp"; fi
      cat "$_cl_obj" >> "$_cl_tmp"
      rm -f "$_cl_obj"
    done
    printf ']}' >> "$_cl_tmp"
    CL_JSON="$(head -c 6144 "$_cl_tmp")"
  fi
  rm -f "$_cl_tmp"
  if [ -n "$CL_JSON" ] && command -v jsonfilter >/dev/null 2>&1; then
    # discard malformed captures; jsonfilter exits non-zero on bad JSON
    jsonfilter -s "$CL_JSON" -e '.' >/dev/null 2>&1 || CL_JSON=""
  fi
  if [ "${#CL_JSON}" -gt 6144 ]; then
    CL_JSON=""
  fi
}

# ---------------------------------------------------------------------------
# Telemetry push
# ---------------------------------------------------------------------------
push_telemetry() {
  _m_total="$(mem_total_kb)"
  _m_avail="$(mem_available_kb)"
  _m_ct="$(conntrack_count)"
  _m_load="$(load1_value)"
  _m_up="$(uptime_seconds)"
  plc_sample
  clients_sample
  _m_load_json="0"
  case "$_m_load" in
    ''|*[!0-9.]*) _m_load_json="0" ;;
    *) _m_load_json="$_m_load" ;;
  esac
  _m_ct=$(num_or "$_m_ct" 0)
  _m_total=$(num_or "$_m_total" 0)
  _m_avail=$(num_or "$_m_avail" 0)
  _m_up=$(num_or "$_m_up" 0)
  _m_clients="null"
  if [ -n "$CL_JSON" ]; then
    _m_clients="\"$(json_escape "$CL_JSON")\""
  fi
  _m_payload="{\"kind\":\"telemetry\",\"device\":\"${DEVICE_ID}\",\"ts\":$(timestamp_ms),\"schema_ver\":2,"
  _m_payload="${_m_payload}\"metrics\":{\"mem_total_kb\":${_m_total},\"mem_avail_kb\":${_m_avail},\"conntrack\":${_m_ct},\"load1\":${_m_load_json},\"uptime_s\":${_m_up},\"plc_tx_mbps\":${PLC_TX:-0},\"plc_rx_mbps\":${PLC_RX:-0}},"
  _m_payload="${_m_payload}\"clients_json\":${_m_clients}}"
  if [ "${#_m_payload}" -gt 12288 ]; then
    warn "telemetry payload exceeded cap; retrying without clients_json"
    _m_payload="{\"kind\":\"telemetry\",\"device\":\"${DEVICE_ID}\",\"ts\":$(timestamp_ms),\"schema_ver\":2,\"metrics\":{\"mem_total_kb\":${_m_total},\"mem_avail_kb\":${_m_avail},\"conntrack\":${_m_ct},\"load1\":${_m_load_json},\"uptime_s\":${_m_up},\"plc_tx_mbps\":${PLC_TX:-0},\"plc_rx_mbps\":${PLC_RX:-0}},\"clients_json\":null}"
  fi
  if http_post_json "$ENDPOINT_URL" "/api/ingest" "$_m_payload" 2>/dev/null | grep -q '"ok":true'; then
    FAIL_STREAK="0"
    return 0
  fi
  FAIL_STREAK=$((FAIL_STREAK + 1))
  warn "telemetry push failed (streak=${FAIL_STREAK})"
  return 1
}

# ---------------------------------------------------------------------------
# CommandLane polling + execution
# ---------------------------------------------------------------------------
_json_field() {
  # $1 = json, $2 = jsonfilter path, $3 = key for grep fallback (string+number)
  _j_json="$1"; _j_expr="$2"; _j_key="$3"
  if command -v jsonfilter >/dev/null 2>&1; then
    jsonfilter -s "$_j_json" -e "$_j_expr" 2>/dev/null | head -n 1
    return 0
  fi
  _j_val="$(printf '%s' "$_j_json" | grep -o "\"${_j_key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null | head -n 1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
  if [ -n "$_j_val" ]; then
    printf '%s' "$_j_val"
    return 0
  fi
  printf '%s' "$_j_json" | grep -o "\"${_j_key}\"[[:space:]]*:[[:space:]]*[0-9.]\{1,\}" 2>/dev/null | head -n 1 | sed 's/.*:[[:space:]]*//'
}

json_field() {
  _json_field "$1" "$2" "${3:-}"
}

ack_command() {
  _a_id="$1"; _a_ok="$2"; _a_detail="$3"
  _a_payload="{\"command_id\":\"${_a_id}\",\"ok\":${_a_ok},\"detail\":\"$(json_escape "$_a_detail")\"}"
  http_post_json "$ENDPOINT_URL" "/api/commands/ack" "$_a_payload" >/dev/null 2>&1 || warn "ack failed for ${_a_id}"
}

poll_commands() {
  _pc_resp="$(http_get_signed "/api/commands/pending" "device=${DEVICE_ID}" 2>/dev/null)" || {
    warn "command poll failed"
    return 1
  }
  printf '%s' "$_pc_resp" | grep -q '"commands"' || return 0
  _pc_ids=""
  if command -v jsonfilter >/dev/null 2>&1; then
    _pc_ids="$(jsonfilter -s "$_pc_resp" -e '@.commands[*].command_id' 2>/dev/null | tr '\n' ' ')"
  else
    _pc_ids="$(printf '%s' "$_pc_resp" | grep -o '"command_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:[[:space:]]*"//;s/"$//' | tr '\n' ' ')"
  fi
  # shellcheck disable=SC2086
  _pc_idx="0"
  for _pc_id in $_pc_ids; do
    execute_command "$_pc_id" "$_pc_resp" "$_pc_idx"
    _pc_idx=$((_pc_idx + 1))
  done
}

execute_command() {
  _e_id="$1"; _e_resp="$2"; _e_idx="$3"
  _e_cmd=""
  if command -v jsonfilter >/dev/null 2>&1; then
    _e_cmd="$(jsonfilter -s "$_e_resp" -e "@.commands[${_e_idx}]" 2>/dev/null)"
  fi
  if [ -z "$_e_cmd" ]; then
    # degraded extraction without jsonfilter: first command only
    warn "jsonfilter unavailable: degraded single-command parsing"
    _e_lane="$(json_field "$_e_resp" '@.commands[0].lane' 'lane')"
    _e_action="$(json_field "$_e_resp" '@.commands[0].action' 'action')"
  else
    _e_lane="$(json_field "$_e_cmd" '@.lane' 'lane')"
    _e_action="$(json_field "$_e_cmd" '@.action' 'action')"
  fi
  _e_lane="${_e_lane:-unknown}"
  _e_action="${_e_action:-unknown}"
  log "executing command ${_e_id} lane=${_e_lane} action=${_e_action}"
  case "${_e_lane}/${_e_action}" in
    telemetry_interval/set)    exec_lane_telemetry_interval "$_e_resp" "$_e_cmd" "$_e_id" ;;
    steering_mode/set)         exec_lane_steering "$_e_resp" "$_e_cmd" "$_e_id" ;;
    guest_grant/grant|guest_grant/revoke) exec_lane_guest "$_e_resp" "$_e_cmd" "$_e_id" ;;
    config_apply/apply)        exec_lane_config_apply "$_e_id" ;;
    service_restart/restart)   exec_lane_service_restart "$_e_resp" "$_e_cmd" "$_e_id" ;;
    reboot/schedule)           exec_lane_reboot "$_e_resp" "$_e_cmd" "$_e_id" ;;
    plc_scan/now)              exec_lane_plc_scan "$_e_id" ;;
    *)                         ack_command "$_e_id" false "unsupported lane/action ${_e_lane}/${_e_action}" ;;
  esac
}

lane_payload_value() {
  # extract payload.<key> from either full response or single command JSON
  _v_resp="$1"; _v_cmd="$2"; _v_path="$3"; _v_key="$4"
  if [ -n "$_v_cmd" ]; then
    json_field "$_v_cmd" "@.payload.${_v_path}" "${_v_key}"
  else
    json_field "$_v_resp" "@.commands[0].payload.${_v_path}" "${_v_key}"
  fi
}

exec_lane_telemetry_interval() {
  _t_resp="$1"; _t_cmd="$2"; _t_id="$3"
  _t_secs="$(lane_payload_value "$_t_resp" "$_t_cmd" 'seconds' 'seconds')"
  _t_secs="$(num_or "$_t_secs" 0)"
  if [ "$_t_secs" -lt 30 ] || [ "$_t_secs" -gt 900 ]; then
    ack_command "$_t_id" false "seconds out of range 30-900"
    return 0
  fi
  if sed -i "s/^TELEMETRY_INTERVAL=.*/TELEMETRY_INTERVAL=${_t_secs}/" "$AV_ENV" 2>/dev/null; then
    log "telemetry interval set to ${_t_secs}s"
    ack_command "$_t_id" true "interval=${_t_secs}s"
  else
    ack_command "$_t_id" false "could not rewrite ${AV_ENV}"
  fi
}

exec_lane_steering() {
  _s_resp="$1"; _s_cmd="$2"; _s_id="$3"
  _s_mode="$(lane_payload_value "$_s_resp" "$_s_cmd" 'mode' 'mode')"
  case "$_s_mode" in
    balanced|aggressive|disabled) ;;
    *) ack_command "$_s_id" false "invalid steering mode"; return 0 ;;
  esac
  command -v uci >/dev/null 2>&1 || { ack_command "$_s_id" false "uci unavailable"; return 0; }
  if [ "$_s_mode" = "disabled" ]; then
    [ -x /etc/init.d/usteer ] && /etc/init.d/usteer stop 2>/dev/null
    uci -q set usteer.@usteer[0].disabled='1' 2>/dev/null || true
  else
    uci -q set usteer.@usteer[0].disabled='0' 2>/dev/null || true
    case "$_s_mode" in
      balanced)   uci -q set usteer.@usteer[0].min_connect_snr='25' 2>/dev/null || true ;;
      aggressive) uci -q set usteer.@usteer[0].min_connect_snr='35' 2>/dev/null || true ;;
    esac
    [ -x /etc/init.d/usteer ] && /etc/init.d/usteer restart 2>/dev/null
  fi
  uci -q commit usteer 2>/dev/null || true
  log "steering mode applied: ${_s_mode}"
  ack_command "$_s_id" true "mode=${_s_mode}"
}

exec_lane_guest() {
  _g_resp="$1"; _g_cmd="$2"; _g_id="$3"
  _g_mac="$(lane_payload_value "$_g_resp" "$_g_cmd" 'mac' 'mac')"
  _g_minutes="$(num_or "$(lane_payload_value "$_g_resp" "$_g_cmd" 'minutes' 'minutes')" 240)"
  _g_action="$(lane_payload_value "$_g_resp" "$_g_cmd" 'action' 'action')"
  [ -n "$_g_action" ] || _g_action="$(json_field "$_g_resp" '@.action' 'action')"
  case "$_g_mac" in
    [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]) ;;
    *) ack_command "$_g_id" false "invalid MAC"; return 0 ;;
  esac
  mkdir -p "$AV_GRANTS" 2>/dev/null || true
  _g_mac_lc="$(printf '%s' "$_g_mac" | tr 'A-F' 'a-f')"
  if [ "$_g_action" = "revoke" ]; then
    guest_revoke_mac "$_g_mac_lc"
    ack_command "$_g_id" true "revoked ${_g_mac_lc}"
    return 0
  fi
  if ! uci -q add firewall rule >/dev/null 2>&1; then
    ack_command "$_g_id" false "firewall config unavailable"
    return 0
  fi
  _g_name="avanza_guest_${_g_mac_lc}"
  uci -q set "firewall.@rule[-1].name=${_g_name}" 2>/dev/null || true
  uci -q set "firewall.@rule[-1].src=guest" 2>/dev/null || true
  uci -q set "firewall.@rule[-1].src_mac=${_g_mac_lc}" 2>/dev/null || true
  uci -q set "firewall.@rule[-1].dest=wan" 2>/dev/null || true
  uci -q set "firewall.@rule[-1].target=ACCEPT" 2>/dev/null || true
  uci -q commit firewall 2>/dev/null || true
  /etc/init.d/firewall reload >/dev/null 2>&1 || true
  printf '%s\n' "$(( $(date +%s) + _g_minutes * 60 ))" > "${AV_GRANTS}/${_g_mac_lc}.exp"
  log "guest grant applied: ${_g_mac_lc} for ${_g_minutes}m"
  ack_command "$_g_id" true "granted ${_g_mac_lc} ttl=${_g_minutes}m"
}

guest_revoke_mac() {
  _r_mac="$1"
  _r_name="avanza_guest_${_r_mac}"
  if command -v uci >/dev/null 2>&1; then
    for _r_sec in $(uci -q show firewall 2>/dev/null | awk -F. '/^firewall\..*\.name=/' | awk -F. '{print $2}' | sort -u); do
      _r_val="$(uci -q get "firewall.${_r_sec}.name" 2>/dev/null || printf '')"
      [ "$_r_val" = "$_r_name" ] && uci -q delete "firewall.${_r_sec}" 2>/dev/null || true
    done
    uci -q commit firewall 2>/dev/null || true
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
  fi
  rm -f "${AV_GRANTS}/${_r_mac}.exp" 2>/dev/null || true
}

sweep_guest_grants() {
  [ -d "$AV_GRANTS" ] || return 0
  _sw_now="$(date +%s)"
  for _sw_f in "${AV_GRANTS}"/*.exp; do
    [ -f "$_sw_f" ] || return 0
    _sw_exp="$(cat "$_sw_f" 2>/dev/null | tr -cd '0-9')"
    case "$_sw_exp" in
      ''|*[!0-9]*) rm -f "$_sw_f"; continue ;;
    esac
    if [ "$_sw_now" -ge "$_sw_exp" ]; then
      _sw_mac="$(basename "$_sw_f" .exp)"
      guest_revoke_mac "$_sw_mac"
      log "guest grant expired: ${_sw_mac}"
    fi
  done
}

exec_lane_service_restart() {
  _x_resp="$1"; _x_cmd="$2"; _x_id="$3"
  _x_svc="$(lane_payload_value "$_x_resp" "$_x_cmd" 'service' 'service')"
  case "$_x_svc" in
    network|firewall|wireless|usteer) ;;
    agent)
      printf '%s\n' restart > "${AV_DIR}/agent.restart"
      ack_command "$_x_id" true "agent restart flagged"
      return 0
      ;;
    *) ack_command "$_x_id" false "unsupported service"; return 0 ;;
  esac
  if [ -x "/etc/init.d/${_x_svc}" ]; then
    /etc/init.d/"${_x_svc}" restart >/dev/null 2>&1 || true
    ack_command "$_x_id" true "restarted ${_x_svc}"
  else
    ack_command "$_x_id" false "service init script absent: ${_x_svc}"
  fi
}

exec_lane_reboot() {
  _rb_resp="$1"; _rb_cmd="$2"; _rb_id="$3"
  _rb_delay="$(num_or "$(lane_payload_value "$_rb_resp" "$_rb_cmd" 'delay_seconds' 'delay_seconds')" 30)"
  [ "$_rb_delay" -le 3600 ] || _rb_delay="3600"
  ack_command "$_rb_id" true "reboot scheduled in ${_rb_delay}s (boot recovery enforces rollback matrix)"
  log "reboot scheduled in ${_rb_delay}s"
  ( sleep "$_rb_delay" && sync && reboot -f ) >/dev/null 2>&1 &
}

exec_lane_plc_scan() {
  _sc_id="$1"
  plc_sample
  push_plc_links
  ack_command "$_sc_id" true "plc scan pushed (tx=${PLC_TX:-0} rx=${PLC_RX:-0})"
}

# ---------------------------------------------------------------------------
# 10-minute automated configuration rollback safety matrix
# ---------------------------------------------------------------------------
cf_health_ok() {
  http_get_public "/api/health" 2>/dev/null | grep -q '"ok":true'
}

gateway_ok() {
  _gw="$(default_gateway)"
  [ -n "$_gw" ] || return 1
  ping -c 1 -W 2 "$_gw" >/dev/null 2>&1
}

begin_rollback_window() {
  _b_label="$1"; _b_backup="$2"
  printf 'deadline=%s\nbackup=%s\nlabel=%s\nfailures=0\nconfirmed=0\n' \
    "$(( $(date +%s) + ROLLBACK_WINDOW ))" "$_b_backup" "$(json_escape "$_b_label")" > "$AV_PENDING"
  sync
  log "rollback window opened (${ROLLBACK_WINDOW}s): ${_b_label}"
}

check_rollback_pending() {
  [ -f "$AV_PENDING" ] || return 0
  _c_deadline="$(awk -F= '/^deadline=/{print $2}' "$AV_PENDING" | tr -cd '0-9')"
  _c_backup="$(awk -F= '/^backup=/{print $2}' "$AV_PENDING")"
  _c_label="$(awk -F= '/^label=/{print substr($0,7)}' "$AV_PENDING")"
  _c_failures="$(awk -F= '/^failures=/{print $2}' "$AV_PENDING" | tr -cd '0-9')"
  _c_failures="$(num_or "$_c_failures" 0)"
  _c_gw=0; _c_cf=0
  gateway_ok && _c_gw=1
  cf_health_ok && _c_cf=1
  if [ "$_c_gw" = "1" ] && [ "$_c_cf" = "1" ]; then
    rm -f "$AV_PENDING"
    sync
    log "config change CONFIRMED (${_c_label}): gateway + Cloudflare health verified"
    return 0
  fi
  if [ "$_c_gw" = "0" ]; then
    _c_failures=$((_c_failures + 1))
  fi
  _c_now="$(date +%s)"
  if [ "$_c_failures" -ge 3 ] || [ "$_c_now" -ge "$_c_deadline" ]; then
    warn "rollback triggered (${_c_label}): gw=${_c_gw} cf=${_c_cf} failures=${_c_failures}"
    rollback_now "$_c_backup"
  else
    printf 'deadline=%s\nbackup=%s\nlabel=%s\nfailures=%s\nconfirmed=0\n' \
      "$_c_deadline" "$_c_backup" "$_c_label" "$_c_failures" > "$AV_PENDING"
  fi
}

rollback_now() {
  _rbk_backup="$1"
  warn "ROLLBACK: restoring ${_rbk_backup} and rebooting"
  if [ -f "$_rbk_backup" ] && tar -tzf "$_rbk_backup" >/dev/null 2>&1; then
    tar -xzf "$_rbk_backup" -C /
    sync
    rm -f "$AV_PENDING"
    reboot -f
  else
    warn "rollback backup unusable; rebooting to last persisted config"
    rm -f "$AV_PENDING"
    reboot -f
  fi
}

# ---------------------------------------------------------------------------
# GitOps fleet bundle application (KV version token -> R2 blob -> device)
# ---------------------------------------------------------------------------
fleet_version_check() {
  _fv_remote="$(http_get_public "/api/fleet/version" 2>/dev/null | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
  [ -n "$_fv_remote" ] || return 0
  _fv_local="$(cat "${AV_DIR}/fleet.version" 2>/dev/null || printf '')"
  [ "$_fv_remote" = "$_fv_local" ] && return 0
  log "fleet version drift: local='${_fv_local:-none}' remote='${_fv_remote}'"
  fleet_bundle_apply "$_fv_remote"
}

fleet_bundle_apply() {
  _fa_version="$1"
  _fa_bundle="/tmp/avanza-bundle.tar.gz"
  _fa_stage="/tmp/avanza-stage"
  case "$_fa_version" in
    ''|*[!0-9a-f]*) warn "invalid fleet version token"; return 1 ;;
  esac
  _fa_tls="$( _fetch_tls_args )"
  rm -rf "$_fa_stage"
  mkdir -p "$_fa_stage"
  # shellcheck disable=SC2086
  uclient_fetch_or_curl "${ENDPOINT_URL}/api/fleet/bundle/latest" "$_fa_bundle" "$_fa_tls" || {
    warn "bundle download failed"; return 1;
  }
  _fa_sha="$(sha256sum "$_fa_bundle" 2>/dev/null | awk '{print $1}')"
  if [ "$_fa_sha" != "$_fa_version" ]; then
    warn "bundle sha256 mismatch: got=${_fa_sha:-none} want=${_fa_version}"
    rm -f "$_fa_bundle"
    return 1
  fi
  tar -xzf "$_fa_bundle" -C "$_fa_stage" 2>/dev/null || { warn "bundle untar failed"; return 1; }
  [ -f "${_fa_stage}/manifest.json" ] || { warn "bundle manifest missing"; return 1; }
  for _fa_cfg in "${_fa_stage}"/etc-config/*; do
    [ -f "$_fa_cfg" ] || continue
    _fa_name="$(basename "$_fa_cfg")"
    mkdir -p /tmp/avanza-uci-test
    rm -f "/tmp/avanza-uci-test/${_fa_name}"
    if ! UCI_CONFIG_DIR=/tmp/avanza-uci-test uci -q import "$_fa_name" < "$_fa_cfg" >/dev/null 2>&1; then
      warn "bundle UCI validation failed: ${_fa_name}"; rm -rf "$_fa_stage" "$_fa_bundle"
      return 1
    fi
  done
  _fa_backup="${AV_BACKUPS}/pre-fleet-$(date +%Y%m%d%H%M%S).tar.gz"
  mkdir -p "$AV_BACKUPS"
  tar -czf "$_fa_backup" -C / etc/config etc/avanza usr/bin/avanza-agent 2>/dev/null || true
  for _fa_cfg in "${_fa_stage}"/etc-config/*; do
    [ -f "$_fa_cfg" ] || continue
    _fa_name="$(basename "$_fa_cfg")"
    cp "$_fa_cfg" "/etc/config/${_fa_name}" || { warn "config install failed: ${_fa_name}"; return 1; }
  done
  if [ -f "${_fa_stage}/bin/avanza-agent" ]; then
    cp "${_fa_stage}/bin/avanza-agent" /usr/bin/avanza-agent.new 2>/dev/null || true
    chmod 755 /usr/bin/avanza-agent.new 2>/dev/null || true
    mv -f /usr/bin/avanza-agent.new /usr/bin/avanza-agent 2>/dev/null || true
  fi
  rm -rf "$_fa_stage" "$_fa_bundle"
  /etc/init.d/network reload >/dev/null 2>&1 || true
  /etc/init.d/firewall reload >/dev/null 2>&1 || true
  wifi reload >/dev/null 2>&1 || true
  begin_rollback_window "fleet:${_fa_version}" "$_fa_backup"
  printf '%s\n' "$_fa_version" > "${AV_DIR}/fleet.version"
  log "fleet bundle ${_fa_version} applied; rollback matrix active for ${ROLLBACK_WINDOW}s"
}

uclient_fetch_or_curl() {
  _u_url="$1"; _u_out="$2"; _u_tls="$3"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 60 -o "$_u_out" "$_u_url" 2>/dev/null
    return $?
  fi
  # shellcheck disable=SC2086
  uclient-fetch -q -O "$_u_out" --timeout=60 ${_u_tls} "$_u_url" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Edge-throughput lane (RAM-safe: uclient-fetch streams to /dev/null)
# ---------------------------------------------------------------------------
exec_lane_config_apply() {
  _ca_id="$1"
  fleet_bundle_apply "$(http_get_public "/api/fleet/version" 2>/dev/null | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*:[[:space:]]*"//;s/"$//')" \
    && ack_command "$_ca_id" true "bundle applied under rollback matrix" \
    || ack_command "$_ca_id" false "bundle apply failed; see syslog"
}

speedtest_run() {
  [ "$ENABLE_SPEEDTEST" = "1" ] || return 0
  _sp_last="$(cat "${AV_DIR}/last-speedtest" 2>/dev/null | tr -cd '0-9')"
  _sp_last="$(num_or "$_sp_last" 0)"
  _sp_now="$(date +%s)"
  [ "$((_sp_now - _sp_last))" -lt "$SPEEDTEST_INTERVAL" ] && return 0
  _sp_start="$(uptime_now)"
  _sp_tls="$( _fetch_tls_args )"
  _sp_url="${ENDPOINT_URL}/api/speedtest/payload?cb=${_sp_now}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 120 -o /dev/null "$_sp_url" 2>/dev/null || { warn "speedtest fetch failed"; return 0; }
  else
    # shellcheck disable=SC2086
    uclient-fetch -q -O /dev/null --timeout=120 ${_sp_tls} "$_sp_url" >/dev/null 2>&1 || { warn "speedtest fetch failed"; return 0; }
  fi
  _sp_end="$(uptime_now)"
  _sp_dt="$(awk -v a="$_sp_end" -v b="$_sp_start" 'BEGIN{printf "%d", (a-b)*1000}')"
  [ "$_sp_dt" -ge 500 ] || { warn "speedtest window too short (${_sp_dt}ms)"; return 0; }
  _sp_mbps="$(awk -v n="$SPEEDTEST_PAYLOAD_BYTES" -v ms="$_sp_dt" 'BEGIN{printf "%.2f", (n*8)/(ms/1000)/1000000}')"
  _sp_payload="{\"kind\":\"speedtest\",\"device\":\"${DEVICE_ID}\",\"ts\":$(timestamp_ms),\"mbps\":${_sp_mbps},\"duration_ms\":${_sp_dt},\"payload_bytes\":${SPEEDTEST_PAYLOAD_BYTES}}"
  if http_post_json "$ENDPOINT_URL" "/api/ingest" "$_sp_payload" 2>/dev/null | grep -q '"ok":true'; then
    printf '%s\n' "$_sp_now" > "${AV_DIR}/last-speedtest"
    log "edge throughput: ${_sp_mbps} Mbps over ${SPEEDTEST_PAYLOAD_BYTES}B / ${_sp_dt}ms"
  fi
}

# ---------------------------------------------------------------------------
# Guest access request sampling (feeds evaluate_guest_requests)
# ---------------------------------------------------------------------------
guest_requests_sample() {
  [ "$ENABLE_GUEST_SAMPLING" = "1" ] || return 0
  [ -n "$GUEST_IFACES" ] || return 0
  command -v ubus >/dev/null 2>&1 || return 0
  _gr_reqs=""
  _gr_first="1"
  _gr_list="/tmp/avanza-gm.$$"
  for _gr_if in $GUEST_IFACES; do
    _gr_out="/tmp/avanza-guest.$$"
    ubus -S call "hostapd.${_gr_if}" get_clients > "$_gr_out" 2>/dev/null || { rm -f "$_gr_out"; continue; }
    [ -s "$_gr_out" ] || { rm -f "$_gr_out"; continue; }
    _gr_assoc_macs "$_gr_out" "$_gr_list"
    while IFS= read -r _gr_mac; do
      [ -n "$_gr_mac" ] || continue
      if [ "$_gr_first" = "1" ]; then _gr_first="0"; else _gr_reqs="${_gr_reqs},"; fi
      _gr_reqs="${_gr_reqs}{\"id\":\"${_gr_mac}-${DEVICE_ID}\",\"mac\":\"${_gr_mac}\",\"hostname\":\"\",\"note\":\"new guest association on ${_gr_if}\"}"
    done < "$_gr_list"
    rm -f "$_gr_out"
  done
  rm -f "$_gr_list"
  [ -n "$_gr_reqs" ] || return 0
  _gr_payload="{\"kind\":\"guest_request\",\"device\":\"${DEVICE_ID}\",\"ts\":$(timestamp_ms),\"requests\":[${_gr_reqs}]}"
  http_post_json "$ENDPOINT_URL" "/api/ingest" "$_gr_payload" >/dev/null 2>&1 || warn "guest_request ingest failed"
}

_gr_assoc_macs() {
  # $1 = hostapd/usteer JSON file, $2 = output file (one MAC per line).
  # hostapd keys the clients object by MAC, so a text scan is format-stable
  # and avoids jsonfilter's lack of object-key iteration.
  _gm_src="$1"; _gm_out="$2"
  : > "$_gm_out"
  tr ',{}' '\n\n\n' < "$_gm_src" 2>/dev/null | grep -o '[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]' | tr 'A-F' 'a-f' | sort -u > "$_gm_out" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Provisioning: install, init.d (procd), crond watchdog, boot recovery
# ---------------------------------------------------------------------------
do_install() {
  _i_url="${1:-}"; _i_device="${2:-}"; _i_key="${3:-}"
  [ -n "$_i_url" ] && [ -n "$_i_device" ] && [ -n "$_i_key" ] || {
    printf 'usage: %s install ENDPOINT_URL DEVICE_ID KEY64HEX\n' "$0" >&2
    exit 1
  }
  case "$_i_url" in
    https://*|http://*) ;;
    *) printf 'endpoint must be http(s)\n' >&2; exit 1 ;;
  esac
  case "$_i_device" in
    *[!a-z0-9_-]*|"") printf 'device id must match [a-z0-9_-]\n' >&2; exit 1 ;;
  esac
  _i_key_clean="$(printf '%s' "$_i_key" | tr -cd '0-9a-f')"
  [ "${#_i_key_clean}" -ge 32 ] && [ "${#_i_key_clean}" -le 64 ] || {
    printf 'key must be 32-64 hex chars\n' >&2; exit 1;
  }
  mkdir -p "$AV_DIR" "$AV_BACKUPS" "$AV_GRANTS"
  printf 'ENDPOINT_URL=%s\nDEVICE_ID=%s\nTELEMETRY_INTERVAL=60\nPLC_IFACE=eth1\nMEM_GUARD_KB=10240\nROLLBACK_WINDOW=600\nENABLE_SPEEDTEST=0\nSPEEDTEST_INTERVAL=21600\nSPEEDTEST_PAYLOAD_BYTES=5242880\nENABLE_GUEST_SAMPLING=0\nGUEST_IFACES=\nGW_OVERRIDE=\n' \
    "$_i_url" "$_i_device" > "$AV_ENV"
  printf '%s\n' "$_i_key_clean" > "$AV_SECRET"
  chmod 600 "$AV_SECRET"
  chmod 644 "$AV_ENV"
  cp "$0" /usr/bin/avanza-agent.new && chmod 755 /usr/bin/avanza-agent.new && mv -f /usr/bin/avanza-agent.new /usr/bin/avanza-agent
  cat > /etc/init.d/avanza-agent <<'INITD'
#!/bin/sh /etc/rc.common
START=99
STOP=10
USE_PROCD=1
PROG=/usr/bin/avanza-agent
start_service() {
  procd_open_instance
  procd_set_param command "$PROG" run
  procd_set_param respawn 3600 5 0
  procd_set_param stdout 0
  procd_set_param stderr 0
  procd_set_param env RAM_BUDGET_MB="48"
  procd_close_instance
}
INITD
  chmod 755 /etc/init.d/avanza-agent
  cat > "${AV_DIR}/boot_recover.sh" <<'RECOVER'
#!/bin/sh
# AVANZA boot recovery: enforce pending rollback matrix after reboot.
P=/etc/avanza/rollback.pending
[ -f "$P" ] || exit 0
sleep 90
GW=$(awk -F= '/^gateway=/{print $2}' /etc/avanza/agent.env 2>/dev/null)
[ -n "$GW" ] || GW=$(route -n 2>/dev/null | awk '$1 == "0.0.0.0" {print $2; exit}')
i=0
while [ "$i" -lt 20 ]; do
  ping -c 1 -W 2 "$GW" >/dev/null 2>&1 && { rm -f "$P"; logger -t avanza-recover "rollback window cleared post-boot"; exit 0; }
  i=$((i + 1))
  sleep 6
done
B=$(awk -F= '/^backup=/{print $2}' "$P")
if [ -f "$B" ] && tar -tzf "$B" >/dev/null 2>&1; then
  tar -xzf "$B" -C /
  sync
  rm -f "$P"
  logger -t avanza-recover "post-boot rollback executed; rebooting"
  reboot -f
fi
exit 1
RECOVER
  chmod 755 "${AV_DIR}/boot_recover.sh"
  /etc/init.d/avanza-agent enable 2>/dev/null || true
  /etc/init.d/avanza-agent start 2>/dev/null || true
  touch /etc/crontabs/root
  grep -q 'avanza-agent watchdog' /etc/crontabs/root 2>/dev/null || \
    printf '*/5 * * * * /usr/bin/avanza-agent watchdog\n' >> /etc/crontabs/root
  grep -q 'avanza boot_recover' /etc/crontabs/root 2>/dev/null || \
    printf '@reboot /etc/avanza/boot_recover.sh # avanza boot_recover\n' >> /etc/crontabs/root
  /etc/init.d/crond restart >/dev/null 2>&1 || true
  log "installed: env=${AV_ENV} secret=${AV_SECRET} init=avanza-agent cron=watchdog+boot_recover"
  printf '{"ok":true,"device":"%s","endpoint":"%s","install":"complete"}\n' "$_i_device" "$_i_url"
}

do_watchdog() {
  if ! pidof avanza-agent >/dev/null 2>&1; then
    [ -x /etc/init.d/avanza-agent ] && /etc/init.d/avanza-agent start >/dev/null 2>&1 \
      && warn "watchdog relaunched avanza-agent"
  fi
  exit 0
}

do_boot_recover() {
  [ -x "${AV_DIR}/boot_recover.sh" ] && sh "${AV_DIR}/boot_recover.sh"
  exit 0
}

# ---------------------------------------------------------------------------
# Main memory-loop
# ---------------------------------------------------------------------------
sleep_fragment() {
  _sf_total="$(num_or "$1" 60)"
  while [ "$_sf_total" -gt 0 ]; do
    _sf_step="5"
    [ "$_sf_total" -lt 5 ] && _sf_step="$_sf_total"
    sleep "$_sf_step"
    _sf_total=$((_sf_total - _sf_step))
  done
}

main_run() {
  trap 'log "SIGTERM received: exiting cleanly"; exit 0' TERM INT
  acquire_lock
  load_env
  mkdir -p "$AV_BACKUPS" "$AV_GRANTS"
  log "agent v2 running: device=${DEVICE_ID} interval=${TELEMETRY_INTERVAL}s rollback=${ROLLBACK_WINDOW}s"
  while :; do
    load_env
    _r_avail="$(mem_available_kb)"
    if [ "$_r_avail" -lt "$MEM_GUARD_KB" ]; then
      warn "memory guard engaged (${_r_avail}kB < ${MEM_GUARD_KB}kB): cycle deferred"
      sleep_fragment 30
      continue
    fi
    _r_sleep="$TELEMETRY_INTERVAL"
    if push_telemetry; then
      push_plc_links
    else
      _r_backoff="1"
      if [ "$FAIL_STREAK" -gt 4 ]; then _r_backoff="16"
      elif [ "$FAIL_STREAK" -gt 3 ]; then _r_backoff="8"
      elif [ "$FAIL_STREAK" -gt 2 ]; then _r_backoff="4"
      elif [ "$FAIL_STREAK" -gt 1 ]; then _r_backoff="2"
      fi
      _r_sleep=$((_r_sleep * _r_backoff))
      [ "$_r_sleep" -gt 900 ] && _r_sleep="900"
    fi
    check_rollback_pending
    poll_commands || true
    fleet_version_check || true
    speedtest_run || true
    guest_requests_sample || true
    sweep_guest_grants || true
    if [ -f "${AV_DIR}/agent.restart" ]; then
      rm -f "${AV_DIR}/agent.restart"
      log "restart flag: exec-ing fresh agent image"
      exec /usr/bin/avanza-agent run
    fi
    sleep_fragment "$_r_sleep"
  done
}

case "${1:-run}" in
  run)            main_run ;;
  install)        shift; do_install "$@" ;;
  watchdog)       do_watchdog ;;
  boot-recover)   do_boot_recover ;;
  boot_recover)   do_boot_recover ;;
  *)
    printf 'usage: %s run | install ENDPOINT DEVICE_ID KEY64 | watchdog | boot-recover\n' "$0"
    exit 1
    ;;
esac
