#!/bin/sh
# ============================================================================
# PROJECT AVANZA — avanza-router-secondary / scripts/strip_secondary.sh
# Target: TP-Link TD-W8968 v3 @ OpenWrt 25.12.6 (apk package manager)
# Purpose: convert the device into a pure Layer-2 managed switch node by
#          purging DSL/ATM modem subsystems, wireless drivers and daemons,
#          and all web/admin UI planes, then locking the box onto the
#          isolated VLAN 40 management pipeline.
#
# Modes:
#   strip_secondary.sh apply [--network FILE] [--force] [--dry-run]
#       Run preflight, snapshot, package purge, service lockdown. When
#       --network is given, the rendered UCI layout is staged and a detached
#       stage-2 committer is armed (survives the ssh session drop caused by
#       the bridge reconfiguration).
#   strip_secondary.sh --commit-network
#       Stage-2: import staged network layout, verify gateway reachability,
#       auto-rollback to network.preavanza on failure. Run detached.
#   strip_secondary.sh --verify
#       Post-strip assertion pass; prints a JSON summary.
#
# Exit codes: 0 ok, 1 preflight/verify failure, 2 commit rollback engaged.
# ============================================================================
set -u

AV_DIR="/etc/avanza"
AV_BACKUPS="${AV_DIR}/backups"
AV_STAGED_NETWORK="${AV_DIR}/staged-network.uci"
AV_LOG="${AV_DIR}/strip.log"
MGMT_GW="10.40.0.1"
MGMT_IP="10.40.0.2"

# Never removable under any purge category
PROTECTED="kernel base-files busybox dropbear uci libuci ubus libubus ubox netifd libubox logd jsonfilter mtd libc libgcc apk-tools openwrt-keyring ca-bundles"
# Base services that must remain enabled on the L2 switch plane
KEEP_SERVICES="dropbear network system crond log sysntpd boot"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" | tee -a "$AV_LOG" 2>/dev/null || printf '[log] %s\n' "$*"
}

fail() {
  log "FATAL: $*"
  printf '{"ok":false,"error":"%s"}\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s apply [--network FILE] [--force] [--dry-run] | --commit-network | --verify\n' "$0"
  exit 1
}

as_root() {
  [ "$(id -u)" = "0" ] || fail "must run as root"
}

ensure_dirs() {
  mkdir -p "$AV_DIR" "$AV_BACKUPS" 2>/dev/null || true
  touch "$AV_LOG" 2>/dev/null || AV_LOG="/tmp/avanza-strip.log"
}

board_guard() {
  _force="$1"
  if [ -r /tmp/sysinfo/model ]; then
    _model="$(head -n1 /tmp/sysinfo/model 2>/dev/null || printf 'unknown')"
    case "$_model" in
      *8968*) log "board model: ${_model}" ;;
      *)
        if [ "$_force" = "1" ]; then
          log "WARN: unexpected board '${_model}', proceeding on --force"
        else
          fail "board '${_model}' is not TD-W8968; use --force to override"
        fi
        ;;
    esac
  else
    log "WARN: /tmp/sysinfo/model unavailable; skipping board check"
  fi
}

apk_guard() {
  command -v apk >/dev/null 2>&1 || fail "apk not found: this script requires OpenWrt 25.12+ (apk-based)"
  if [ -r /etc/openwrt_release ]; then
    # shellcheck disable=SC1091
    . /etc/openwrt_release
    case "${DISTRIB_RELEASE:-unknown}" in
      25.12*|26.*) log "release: ${DISTRIB_RELEASE}" ;;
      *)
        if [ "${FORCE:-0}" = "1" ]; then
          log "WARN: unexpected release '${DISTRIB_RELEASE}', proceeding on --force"
        else
          fail "release '${DISTRIB_RELEASE}' is not 25.12.x; use --force to override"
        fi
        ;;
    esac
  fi
}

installed_names() {
  # Normalize `apk list --installed` lines into bare package names.
  apk list --installed 2>/dev/null | awk '{print $1}' | sed 's/-[0-9][0-9.].*$//' | sort -u
}

is_installed() {
  printf '%s\n' "$INSTALLED_CACHE" | grep -qx "$1"
}

is_protected() {
  for _p in $PROTECTED; do
    [ "$_p" = "$1" ] && return 0
  done
  return 1
}

snapshot_state() {
  _ts="$(date +%Y%m%d%H%M%S)"
  installed_names > "${AV_DIR}/apk-manifest-pre-${_ts}.txt" 2>/dev/null || true
  if command -v sysupgrade >/dev/null 2>&1; then
    sysupgrade -b "${AV_BACKUPS}/pre-strip-${_ts}.tar.gz" >/dev/null 2>&1 \
      && log "config backup: ${AV_BACKUPS}/pre-strip-${_ts}.tar.gz" \
      || log "WARN: sysupgrade -b snapshot failed; continuing"
  fi
  # Keep only the two most recent backups (flash hygiene; timestamped names sort)
  _idx=0
  for _old in $(printf '%s\n' "${AV_BACKUPS}"/pre-strip-*.tar.gz 2>/dev/null | sort -r); do
    [ -f "$_old" ] || continue
    _idx=$((_idx + 1))
    [ "$_idx" -gt 2 ] && rm -f "$_old"
  done
  printf '%s\n' "$_ts"
}

# ---------------------------------------------------------------------------
# Purge catalogue. Every entry is guarded by is_installed (idempotent) and
# is_protected (hard stop before anything destructive).
# ---------------------------------------------------------------------------
purge_catalogue() {
  _mode="$1"
  _web="luci uhttpd uhttpd-mod-ubus rpcd rpcd-mod-file rpcd-mod-ucode ucode-mod-uhtml ucode-mod-fb uwsgi-cgi libuwsgi"
  _modem="linux-atm br2684ctl atm-tools kmod-atm ppp ppp-mod-pppoe ppp-mod-pppoa ppp-mod-pptp ppp-mod-pppol2tp ppp-multilink rp-pppoe xl2tpd pptp l2tpv3tun"
  _radio="kmod-rt2800-pci kmod-rt2800-lib kmod-rt2800-mmio kmod-rt2800-usb kmod-rt2x00-lib kmod-rt2x00-mmio kmod-rt2x00-pci kmod-rt2x00-usb wpad wpad-basic wpad-basic-mbedtls wpad-mini wpad-mesh-openssl hostapd hostapd-common hostapd-common-mini iw iwinfo wpa-cli wpa-supplicant wireless-tools"
  _lan_services="dnsmasq dnsmasq-full odhcpd odhcpd-ipv6only firewall4 nftables kmod-nftables kmod-nft-core kmod-nft-fib kmod-nft-nat kmod-nft-offload"
  _removed=0
  for _category in "$_web" "$_modem" "$_radio" "$_lan_services"; do
    _hits=""
    for _pkg in $_category; do
      is_installed "$_pkg" || continue
      is_protected "$_pkg" && fail "protected package '${_pkg}' matched a purge category — aborting"
      _hits="$_hits $_pkg"
    done
    [ -z "$_hits" ] && continue
    if [ "$_mode" = "dry" ]; then
      log "DRY-RUN would purge:${_hits}"
      continue
    fi
    # shellcheck disable=SC2086
    log "purging category batch:${_hits}"
    # shellcheck disable=SC2086
    if apk del $_hits >>"$AV_LOG" 2>&1; then
      _removed=$((_removed + 1))
    else
      log "WARN: batch del failed; retrying individually"
      # shellcheck disable=SC2086
      for _pkg in $_hits; do
        apk del "$_pkg" >>"$AV_LOG" 2>&1 || log "WARN: could not remove ${_pkg}"
      done
    fi
    INSTALLED_CACHE="$(installed_names)"
  done
  if [ "$_mode" = "dry" ]; then
    log "DRY-RUN purge planning complete"
    return 0
  fi
  log "purge transactions completed: ${_removed}"
}

stop_and_disable_services() {
  _mode="$1"
  for _svc in /etc/init.d/*; do
    [ -x "$_svc" ] || continue
    _name="$(basename "$_svc")"
    _keep=0
    for _k in $KEEP_SERVICES; do
      [ "$_k" = "$_name" ] && _keep=1
    done
    [ "$_keep" = "1" ] && continue
    if [ "$_mode" = "dry" ]; then
      log "DRY-RUN would stop+disable service: ${_name}"
      continue
    fi
    "$_svc" stop >/dev/null 2>&1 || true
    "$_svc" disable >/dev/null 2>&1 || true
    log "service stopped+disabled: ${_name}"
  done
  if [ "$_mode" != "dry" ]; then
    for _svc in $KEEP_SERVICES; do
      [ -x "/etc/init.d/${_svc}" ] && /etc/init.d/"${_svc}" enable >/dev/null 2>&1 || true
    done
  fi
}

purge_wireless_config() {
  _mode="$1"
  if [ -f /etc/config/wireless ]; then
    if [ "$_mode" = "dry" ]; then
      log "DRY-RUN would delete /etc/config/wireless"
      return 0
    fi
    rm -f /etc/config/wireless
    log "removed stale wireless configuration"
  fi
}

stage_network_layout() {
  _file="$1"
  [ -r "$_file" ] || fail "network layout not readable: ${_file}"
  mkdir -p /tmp/avanza-uci-test
  : > /tmp/avanza-uci-test/.uci-history 2>/dev/null || true
  rm -f /tmp/avanza-uci-test/network
  # Validate by importing into an isolated UCI context first.
  if ! UCI_CONFIG_DIR=/tmp/avanza-uci-test uci -q import network < "$_file" >/dev/null 2>&1; then
    fail "staged network layout failed UCI import validation"
  fi
  UCI_CONFIG_DIR=/tmp/avanza-uci-test uci -q changes network >/dev/null 2>&1 || true
  cp "$_file" "$AV_STAGED_NETWORK" || fail "could not stage network layout"
  log "network layout staged: ${AV_STAGED_NETWORK} ($(wc -l < "$AV_STAGED_NETWORK") lines)"
}

arm_stage2() {
  _mode="$1"
  [ -f "$AV_STAGED_NETWORK" ] || return 0
  if [ "$_mode" = "dry" ]; then
    log "DRY-RUN would arm detached stage-2 network committer"
    return 0
  fi
  # Detached commit survives the ssh drop caused by br-trunk reconfiguration.
  nohup sh "$0" --commit-network >/dev/null 2>&1 &
  log "stage-2 committer armed (detached pid $!)"
}

commit_network() {
  log "stage-2: committing staged network layout"
  [ -f "$AV_STAGED_NETWORK" ] || fail "no staged network layout present"
  cp /etc/config/network /etc/config/network.preavanza 2>/dev/null || true
  : > /etc/config/network
  if ! uci -q import network < "$AV_STAGED_NETWORK" >>"$AV_LOG" 2>&1; then
    log "FATAL: uci import failed; restoring previous layout"
    cp /etc/config/network.preavanza /etc/config/network 2>/dev/null || true
    /etc/init.d/network reload >/dev/null 2>&1 || true
    exit 2
  fi
  uci commit network >/dev/null 2>&1 || true
  /etc/init.d/network reload >/dev/null 2>&1 || true
  log "stage-2: network reloaded; entering gateway verification loop"
  _attempt=0
  while [ "$_attempt" -lt 30 ]; do
    if ping -c 1 -W 2 "$MGMT_GW" >/dev/null 2>&1; then
      log "stage-2: gateway ${MGMT_GW} reachable; commit confirmed"
      rm -f "$AV_STAGED_NETWORK"
      return 0
    fi
    _attempt=$((_attempt + 1))
    sleep 2
  done
  log "stage-2: gateway unreachable after 60s; rolling back network layout"
  cp /etc/config/network.preavanza /etc/config/network 2>/dev/null || true
  /etc/init.d/network reload >/dev/null 2>&1 || true
  log "stage-2: rollback complete"
  exit 2
}

verify_fleet() {
  _errors=0
  for _p in kernel base-files busybox dropbear uci ubus netifd; do
    is_installed "$_p" || { log "VERIFY-FAIL: required package '${_p}' missing"; _errors=$((_errors + 1)); }
  done
  for _bad in luci-base uhttpd rpcd linux-atm br2684ctl kmod-rt2800-pci wpad-basic-mbedtls dnsmasq firewall4; do
    if is_installed "$_bad"; then
      log "VERIFY-FAIL: purge target still installed: ${_bad}"
      _errors=$((_errors + 1))
    fi
  done
  for _svc in uhttpd rpcd firewall dnsmasq odhcpd; do
    if [ -x "/etc/init.d/${_svc}" ] && /etc/init.d/"${_svc}" enabled 2>/dev/null; then
      log "VERIFY-FAIL: service still enabled: ${_svc}"
      _errors=$((_errors + 1))
    fi
  done
  _mgmt_up=0
  if ping -c 1 -W 2 "$MGMT_GW" >/dev/null 2>&1; then
    _mgmt_up=1
  fi
  _ram_free_kb="$(awk '/MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || printf '0')"
  _release="unknown"
  if [ -r /etc/openwrt_release ]; then
    # shellcheck disable=SC1091
    . /etc/openwrt_release
    _release="${DISTRIB_RELEASE:-unknown}"
  fi
  printf '{"ok":%s,"role":"l2-switch","release":"%s","mgmt_ip":"%s","gateway_reachable":%s,"mem_available_kb":%s,"verify_errors":%s}\n' \
    "$([ "$_errors" = "0" ] && printf true || printf false)" \
    "$_release" "$MGMT_IP" "$_mgmt_up" "${_ram_free_kb:-0}" "$_errors"
  [ "$_errors" = "0" ] && [ "$_mgmt_up" = "1" ]
}

drop_caches() {
  sync
  [ -w /proc/sys/vm/drop_caches ] && printf '3' > /proc/sys/vm/drop_caches 2>/dev/null || true
  _free="$(awk '/MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || printf 'unknown')"
  log "RAM hygiene done; MemAvailable: ${_free} kB"
}

main_apply() {
  _mode="real"
  _network=""
  FORCE=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) _mode="dry" ;;
      --force) FORCE=1 ;;
      --network)
        shift
        [ "${1:-}" = "" ] && usage
        _network="$1"
        ;;
      *) usage ;;
    esac
    shift
  done
  as_root
  ensure_dirs
  log "=== AVANZA strip_secondary apply (mode=${_mode}) ==="
  board_guard "$FORCE"
  apk_guard
  INSTALLED_CACHE="$(installed_names)"
  snapshot_state >/dev/null
  stop_and_disable_services "$_mode"
  INSTALLED_CACHE="$(installed_names)"
  purge_catalogue "$_mode"
  INSTALLED_CACHE="$(installed_names)"
  purge_wireless_config "$_mode"
  INSTALLED_CACHE="$(installed_names)"
  if [ -n "$_network" ]; then
    stage_network_layout "$_network"
  fi
  arm_stage2 "$_mode"
  if [ "$_mode" != "dry" ]; then
    drop_caches
    log "strip pass complete; run '$0 --verify' after stage-2 commit"
  fi
}

main_verify() {
  as_root
  ensure_dirs
  INSTALLED_CACHE="$(installed_names)"
  if verify_fleet; then
    log "verify: PASS"
    exit 0
  fi
  log "verify: FAIL"
  exit 1
}

case "${1:-apply}" in
  apply) shift; main_apply "$@" ;;
  --commit-network) commit_network ;;
  --verify) main_verify ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
