#!/bin/sh
# PROJECT AVANZA / avanza-router-secondary / scripts/strip_secondary.sh
# Converts a TD-W8968 v3 (BCM6318/bmips, 64MB RAM, 8MB flash) into a headless,
# hardened Layer-2 managed switch node: removes DSL/ATM residue, the entire
# wireless stack (b43/Broadcom and rt2800/Ralink candidate lists — guarded),
# and all web/management services; installs the L2 bridge matrix, minimal
# firewall, dropbear-on-fleet-only lockdown and the syslog/telemetry pipe to
# the Cloudflare Worker. POSIX ash, idempotent, every destructive op guarded.
set -u

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

LOG_TAG="avanza-strip"
log() { logger -t "$LOG_TAG" -- "$*" 2>/dev/null; echo "[strip] $*"; }
die() { log "FATAL: $*"; exit 1; }

SAFE_LIST="busybox procd ubusd ubox netifd firewall firewall4 nftables libnftnl uci dropbear base-files opkg apk uclient-fetch jsonfilter openssl-util hexdump flock ip-full bridge kmod-bridge kmod-br-netfilter-disabled"

is_safe() {
	for s in $SAFE_LIST; do [ "$1" = "$s" ] && return 0; done
	return 1
}

del_pkg() {
	pkg="$1"
	[ -n "$pkg" ] || return 0
	is_safe "$pkg" && { log "REFUSING to remove safety package: $pkg"; return 1; }
	if apk info -e "$pkg" >/dev/null 2>&1; then
		log "apk del $pkg"
		apk del "$pkg" >/dev/null 2>&1 || log "WARN: removal failed for $pkg (dependency held?) - continuing"
	fi
}

# ---------- 0. identity + bounds preflight ----------
BOARD=""
ubus call system board >/tmp/board.json 2>/dev/null &&
	BOARD=$(jsonfilter -i /tmp/board.json -e '@.model' 2>/dev/null)
rm -f /tmp/board.json
log "detected model: ${BOARD:-unknown}"
case "$BOARD" in
	*W8968*v3*|*W8968*V3*) : ;;
	*)
		[ "$FORCE" -eq 1 ] || die "not a TD-W8968 v3 (model='${BOARD}'). Re-run with --force to override."
		log "model mismatch overridden by --force"
		;;
esac

MEM_KB=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
log "MemTotal: ${MEM_KB} kB"
[ "$MEM_KB" -lt 30000 ] && log "WARN: <32MB detected; proceed only if this really is the switch node"

OVL_USED=$(df -P /overlay 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 + 0 }')
log "overlay usage before strip: ${OVL_USED:-?}%"

# ---------- 1. radios down before driver removal ----------
if command -v wifi >/dev/null 2>&1; then wifi down >/dev/null 2>&1 || true; fi
for svc in wpad hostapd wpa_supplicant usteer; do
	[ -x "/etc/init.d/$svc" ] && { "/etc/init.d/$svc" stop >/dev/null 2>&1 || true; "/etc/init.d/$svc" disable >/dev/null 2>&1 || true; }
done

# ---------- 2. service purge (web/management/dhcp) ----------
for svc in uhttpd rpcd dnsmasq odhcpd luci avahi-daemon miniupnpd; do
	[ -x "/etc/init.d/$svc" ] && { "/etc/init.d/$svc" stop >/dev/null 2>&1 || true; "/etc/init.d/$svc" disable >/dev/null 2>&1 || true; }
done

# ---------- 3. package purge (guarded, both vendor stacks) ----------
# 3a. everything luci/uhttpd/rpcd
for p in $(apk info 2>/dev/null | grep -E '^(luci|uhttpd|rpcd)' | sort); do del_pkg "$p"; done
# 3b. wireless stack — Broadcom (real W8968v3) and Ralink (brief) candidates
for p in \
	kmod-b43 kmod-brcmsmac kmod-brcmutil b43-firmware brcmfmac-firmware \
	kmod-bcma kmod-ssb kmod-cfg80211 kmod-mac80211 iwinfo iw libiwinfo \
	wpad wpad-basic-wolfssl wpad-basic-mbedtls wpad-mesh-wolfssl hostapd \
	hostapd-common wpa-supplicant kmod-rt2800-pci kmod-rt2860-pci kmod-rt2x00-lib \
	kmod-mt76-core kmod-mt76x02-common
do del_pkg "$p"; done
# 3c. DSL/ATM residue (usually absent on bcm6318 OpenWrt — guarded anyway)
for p in \
	br2684ctl linux-atm kmod-atm kmod-mppe kmod-pppoa ppp-mod-pppoa ppp-mod-pppoe \
	dsl-vrx200-firmware-x kmod-ltq-vdsl-vr9 ltq-vdsl-app kmod-dsl-pppoe \
	comgt comgt-ncm kmod-usb-serial-option
do del_pkg "$p"; done
# 3d. dhcp/dns servers (secondary must never serve)
for p in dnsmasq odhcpd-ipv6only odhcpd; do del_pkg "$p"; done

# ---------- 4. config sanitation ----------
mkdir -p /etc/avanza /overlay/avanza 2>/dev/null
: > /etc/config/wireless
uci -q batch <<'UCIEOF'
delete network.wan
delete network.wan6
delete network.dsl0
delete network.atm0
set system.@system[0].hostname='avanza-switch'
set system.@system[0].zonename='UTC'
set dropbear.@dropbear[0].Interface='fleet'
set dropbear.@dropbear[0].Port='22'
set dropbear.@dropbear[0].PasswordAuth='off'
set dropbear.@dropbear[0].RootPasswordAuth='on'
UCIEOF
uci commit system 2>/dev/null
uci commit network 2>/dev/null
uci commit dropbear 2>/dev/null
[ -x /etc/init.d/wireless ] && /etc/init.d/wireless disable 2>/dev/null

# ---------- 5. L2 bridge matrix (network.yml -> UCI) ----------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/transpile_network.sh" ]; then
	sh "$SCRIPT_DIR/transpile_network.sh" --apply || die "network transpile failed - run: sh $SCRIPT_DIR/transpile_network.sh --rollback"
else
	die "transpile_network.sh not found next to this script"
fi

# ---------- 6. minimal local firewall (L2 bridge + fleet SVI lockdown) ----------
uci -q batch <<'UCIEOF'
set firewall.zone_avanza_lo=firewall.zone
set firewall.zone_avanza_lo.name='lo'
set firewall.zone_avanza_lo.input='ACCEPT'
set firewall.zone_avanza_lo.output='ACCEPT'
set firewall.zone_avanza_lo.forward='DROP'
add_list firewall.zone_avanza_lo.network='loopback'
set firewall.zone_avanza_fleet=firewall.zone
set firewall.zone_avanza_fleet.name='fleet'
set firewall.zone_avanza_fleet.input='ACCEPT'
set firewall.zone_avanza_fleet.output='ACCEPT'
set firewall.zone_avanza_fleet.forward='DROP'
add_list firewall.zone_avanza_fleet.network='fleet'
set firewall.zone_avanza_swmedia=firewall.zone
set firewall.zone_avanza_swmedia.name='swmedia'
set firewall.zone_avanza_swmedia.input='DROP'
set firewall.zone_avanza_swmedia.output='ACCEPT'
set firewall.zone_avanza_swmedia.forward='ACCEPT'
add_list firewall.zone_avanza_swmedia.network='switchmedia'
set firewall.fwd_avanza_fleet_wan=firewall.forwarding
set firewall.fwd_avanza_fleet_wan.src='fleet'
set firewall.fwd_avanza_fleet_wan.dest='wan'
set firewall.rule_avanza_sw_ssh=firewall.rule
set firewall.rule_avanza_sw_ssh.name='Avanza-SW-SSH-Fleet-Only'
set firewall.rule_avanza_sw_ssh.src='fleet'
set firewall.rule_avanza_sw_ssh.src_ip='192.168.99.0/24'
set firewall.rule_avanza_sw_ssh.proto='tcp'
set firewall.rule_avanza_sw_ssh.dest_port='22'
set firewall.rule_avanza_sw_ssh.target='ACCEPT'
UCIEOF
uci commit firewall
[ -x /etc/init.d/firewall ] && /etc/init.d/firewall restart >/dev/null 2>&1

# ---------- 7. telemetry + syslog pipe (non-resident loop, procd-managed) ----------
if [ -f "$SCRIPT_DIR/secondary_agent.sh" ]; then
	install -d -m 0755 /usr/libexec/avanza
	install -m 0755 "$SCRIPT_DIR/secondary_agent.sh" /usr/libexec/avanza/secondary_agent.sh
	if [ ! -f /etc/avanza/secondary.env ]; then
		install -m 0600 /dev/null /etc/avanza/secondary.env
		cat > /etc/avanza/secondary.env <<'ENVEOF'
ORCH_URL=https://avanza-edge-orchestrator.YOUR-SUBDOMAIN.workers.dev
AGENT_HMAC_KEY=REPLACE_same_key_as_primary
DEVICE_ID=avanza-switch
INTERVAL=120
ENVEOF
		log ">>> EDIT /etc/avanza/secondary.env (ORCH_URL + AGENT_HMAC_KEY) <<<"
	fi
	if [ -f "$SCRIPT_DIR/avanza-switch.init" ]; then
		install -m 0755 "$SCRIPT_DIR/avanza-switch.init" /etc/init.d/avanza-switch
		/etc/init.d/avanza-switch enable
		/etc/init.d/avanza-switch start
	fi
else
	log "WARN: secondary_agent.sh not found - telemetry pipe not installed"
fi

# ---------- 8. post-strip verification ----------
log "--- verification ---"
free -m 2>/dev/null | head -3
df -h /overlay 2>/dev/null | tail -1
ip -br link show 2>/dev/null | grep -E 'lan|br-switch' || log "WARN: bridge ports not visible yet (reboot pending)"
for leftover in uhttpd luci dnsmasq wpad hostapd br2684ctl; do
	pgrep "$leftover" >/dev/null 2>&1 && log "WARN: $leftover still running"
done
apk info 2>/dev/null | grep -cE '^(luci|uhttpd|wpad|kmod-b43|kmod-mac80211|dnsmasq)' |
	awk '{ if ($1 > 0) print "[strip] WARN: " $1 " wireless/web/dhcp packages still installed"; else print "[strip] purge verified: 0 wireless/web/dhcp packages remain" }'
OVL_AFTER=$(df -P /overlay 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 + 0 }')
log "overlay usage after strip: ${OVL_AFTER:-?}% (was ${OVL_USED:-?}%)"
log "DONE. Reboot to unload purged kernel modules: reboot"
