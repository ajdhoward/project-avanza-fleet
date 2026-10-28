#!/bin/sh
# PROJECT AVANZA / avanza-router-core / router/lightweight_agent_v2.sh
# Fleet-grade primary agent (OpenWrt 25.12, busybox ash, 128MB RAM target:
# userspace-resident <=48MB with TUNNEL_ENABLED=0 default).
# v2 adds: /proc/meminfo MemAvailable, conntrack count/max bounds, plcstat
# Powerline pipeline (non-resident, per-cycle), bridge-FDB client presence,
# GitOps fleet bundle apply (token -> HMAC GET -> sha256 verify -> staging ->
# transpile --apply -> 3-point ping sweep + DNS + orchestrator + tunnel
# validation -> commit or auto-restore) inside the 10-minute rollback matrix.
set -u

AGENT_VERSION="2.0.0"
ENV_FILE="/etc/avanza/agent.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

: "${ORCH_URL:=https://avanza-edge-orchestrator.local.workers.dev}"
: "${AGENT_HMAC_KEY:=}"
: "${INTERVAL:=60}"
: "${OVERLAY_WARN:=85}"
: "${OVERLAY_CRIT:=94}"
: "${RB_DIR:=/overlay/avanza/rollback}"
: "${RB_KEEP:=6}"
: "${RB_WINDOW:=600}"
: "${TUNNEL_ENABLED:=0}"
: "${MIN_EPOCH:=1767225600}"
: "${DEVICE_ID:=avanza-router}"
: "${DEVICE_ROLE:=primary}"
: "${PLC_IF:=lan1}"
: "${PLC_ENABLED:=1}"
: "${FLEET_PEER_IP:=192.168.99.2}"

RUN_DIR="/tmp/avanza"
LOCK_FILE="$RUN_DIR/agent.lock"
PAYLOAD_FILE="$RUN_DIR/payload.json"
RESP_FILE="$RUN_DIR/response.json"
WAN_JSON="$RUN_DIR/wan.json"
SYS_JSON="$RUN_DIR/sys.json"
BOARD_JSON="$RUN_DIR/board.json"
MARKER="$RUN_DIR/pending_rollback"
TEMP_ACCESS="$RUN_DIR/temp_access"
PAUSE_FILE="$RUN_DIR/pauses"
EVENTS_FILE="$RUN_DIR/wan_events"
WAN_STATE_FILE="$RUN_DIR/wan_state"
OUTAGE_STATE_FILE="$RUN_DIR/outage_state"
LATERAL_BASE_FILE="$RUN_DIR/lateral_base"
FDB_BASE_FILE="$RUN_DIR/fdb_base"
FW_VERSION_FILE="/etc/avanza/fleet_version"
APPLY_STATE_FILE="$RUN_DIR/fleet_apply"
SPEEDTEST_PROG="/usr/libexec/avanza/speedtest.sh"
SPEEDTEST_RESULT="$RUN_DIR/speedtest.json"
BACKUP_B64="$RUN_DIR/backup_b64"
LOG_FILE="$RUN_DIR/agent.log"
LOG_MAX=65536

mkdir -p "$RUN_DIR" "$RB_DIR" 2>/dev/null

log() {
	msg="$(date '+%Y-%m-%dT%H:%M:%S') $*"
	logger -t avanza -- "$msg" 2>/dev/null
	echo "$msg" >> "$LOG_FILE" 2>/dev/null
	size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
	if [ "$size" -gt "$LOG_MAX" ]; then
		tail -c 32768 "$LOG_FILE" > "$LOG_FILE.trim" 2>/dev/null && mv "$LOG_FILE.trim" "$LOG_FILE"
	fi
}

exec 9>"$LOCK_FILE" 2>/dev/null
if command -v flock >/dev/null 2>&1; then
	flock -n 9 || { echo "avanza agent already running"; exit 0; }
fi

jesc() { printf '%s' "$1" | tr '\n\t\r' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
jf() { jsonfilter -i "$1" -e "$2" 2>/dev/null; }

require_time() {
	i=0
	while [ "$(date +%s)" -lt "$MIN_EPOCH" ]; do
		i=$((i + 1))
		if [ "$i" -gt 12 ]; then
			log "WARN: clock pre-epoch after 12 NTP attempts; continuing"
			return 0
		fi
		log "clock behind build epoch; forcing NTP (attempt $i/12)"
		ntpd -n -q -p 0.openwrt.pool.ntp.org -p 1.openwrt.pool.ntp.org >/dev/null 2>&1
		sleep 5
	done
	log "time verified: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}

overlay_pct() { df -P /overlay 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 + 0 }'; }

prune_backups() {
	keep="$1"
	[ -d "$RB_DIR" ] || return 0
	total=$(ls -1 "$RB_DIR" 2>/dev/null | wc -l)
	[ "$total" -gt "$keep" ] || return 0
	ls -1 "$RB_DIR" | sort | head -n "$((total - keep))" | while read -r s; do
		rm -rf "$RB_DIR/$s"
		log "pruned rollback snapshot $s"
	done
}

storage_guard() {
	pct=$(overlay_pct)
	[ -n "$pct" ] || pct=0
	if [ "$pct" -ge "$OVERLAY_CRIT" ]; then
		log "STORAGE CRIT: /overlay ${pct}% - emergency prune"
		prune_backups 2
		: > "$LOG_FILE"
		rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
	elif [ "$pct" -ge "$OVERLAY_WARN" ]; then
		log "STORAGE WARN: /overlay ${pct}% - routine prune"
		prune_backups "$RB_KEEP"
	fi
	OVERLAY_PCT="$pct"
}

tunnel_guard() {
	[ "$TUNNEL_ENABLED" = "1" ] || { TUNNEL_STATE="disabled"; return 0; }
	command -v cloudflared >/dev/null 2>&1 || { TUNNEL_STATE="absent"; return 0; }
	if pgrep cloudflared >/dev/null 2>&1; then
		TUNNEL_STATE="up"
	else
		TUNNEL_STATE="restarting"
		log "cloudflared down - restart attempt (GOMEMLIMIT bounded)"
		GOMEMLIMIT=24MiB GOGC=40 /etc/init.d/cloudflared start >/dev/null 2>&1 ||
			log "WARN: cloudflared restart failed; direct HTTPS continues"
	fi
}

wan_dev() { uci -q get network.wan.device 2>/dev/null || uci -q get network.wan.ifname 2>/dev/null || echo "eth0"; }

collect_wan() {
	ubus call network.interface.wan status > "$WAN_JSON" 2>/dev/null || echo '{}' > "$WAN_JSON"
	WAN_UP=$(jf "$WAN_JSON" '@.up' || echo "false")
	WAN_PROTO=$(jf "$WAN_JSON" '@.proto' || echo "unknown")
	WAN_ADDR=$(jf "$WAN_JSON" '@."ipv4-address"[0].address' || echo "")
	WAN_UPTIME=$(jf "$WAN_JSON" '@.uptime' || echo 0)
	prev=$(cat "$WAN_STATE_FILE" 2>/dev/null || echo "")
	if [ -n "$prev" ] && [ "$prev" != "$WAN_UP" ]; then
		echo "{\"ts\":$(date +%s),\"up\":$WAN_UP}" >> "$EVENTS_FILE"
		log "WAN transition: up=$WAN_UP"
	fi
	echo "$WAN_UP" > "$WAN_STATE_FILE"
	dev=$(wan_dev)
	RX_ERR=$(cat "/sys/class/net/$dev/statistics/rx_errors" 2>/dev/null || echo 0)
	TX_ERR=$(cat "/sys/class/net/$dev/statistics/tx_errors" 2>/dev/null || echo 0)
	CARRIER=$(cat "/sys/class/net/$dev/carrier_changes" 2>/dev/null || echo 0)
}

collect_system() {
	ubus call system info > "$SYS_JSON" 2>/dev/null || echo '{}' > "$SYS_JSON"
	MEM_TOTAL=$(jf "$SYS_JSON" '@.memory.total' || echo 0)
	MEM_FREE=$(jf "$SYS_JSON" '@.memory.free' || echo 0)
	SYS_LOAD=$(jf "$SYS_JSON" '@.load[0]' || echo 0)
	SYS_UPTIME=$(jf "$SYS_JSON" '@.uptime' || echo 0)
	MEM_AVAIL=$(awk '/^MemAvailable:/ { print $2 * 1024 }' /proc/meminfo 2>/dev/null || echo 0)
	CT_COUNT=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 0)
	CT_MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 8192)
	OPENWRT_VER=""
	ubus call system board > "$BOARD_JSON" 2>/dev/null &&
		OPENWRT_VER=$(jf "$BOARD_JSON" '@.release.description' | sed 's/^OpenWrt //')
	WIFI_STATIONS=0
	if command -v iwinfo >/dev/null 2>&1; then
		for r in wlan0 wlan1; do
			n=$(iwinfo "$r" assoclist 2>/dev/null | grep -c '^[0-9A-Fa-f][0-9A-Fa-f]:' || true)
			WIFI_STATIONS=$((WIFI_STATIONS + ${n:-0}))
		done
	fi
}

collect_fdb() {
	FDB_JSON=""
	cur_total=0
	for pair in "lan:br-lan" "media:br-media" "iot:br-iot" "guest:br-guest"; do
		z=${pair%%:*}; br=${pair##*:}
		n=0
		command -v bridge >/dev/null 2>&1 && [ -d "/sys/class/net/$br" ] &&
			n=$(bridge fdb show br "$br" 2>/dev/null | grep -vc 'permanent\|self' || echo 0)
		n=${n:-0}
		cur_total=$((cur_total + n))
		FDB_JSON="$FDB_JSON${FDB_JSON:+,}\"$z\":$n"
	done
	prev_total=$(cat "$FDB_BASE_FILE" 2>/dev/null || echo "$cur_total")
	FDB_DELTA=$((cur_total - prev_total))
	echo "$cur_total" > "$FDB_BASE_FILE"
}

collect_plc() {
	PLC_JSON="null"
	[ "$PLC_ENABLED" = "1" ] || return 0
	command -v plcstat >/dev/null 2>&1 || return 0
	[ -n "$PLC_IF" ] || return 0
	raw=$(plcstat -m -i "$PLC_IF" 2>/dev/null | head -c 480 | tr '\n' ' ')
	[ -n "$raw" ] || return 0
	tx=$(printf '%s' "$raw" | sed -n 's/.*[Tt][Xx][^0-9]*\([0-9][0-9.]*\).*/\1/p' | head -n1)
	rx=$(printf '%s' "$raw" | sed -n 's/.*[Rr][Xx][^0-9]*\([0-9][0-9.]*\).*/\1/p' | head -n1)
	at=$(printf '%s' "$raw" | sed -n 's/.*\([0-9][0-9.]*\)[ ]*dB.*/\1/p' | head -n1)
	PLC_JSON=$(printf '{"tx_mbps":"%s","rx_mbps":"%s","atten_db":"%s","iface":"%s","raw":"%s"}' \
		"$(jesc "${tx:-}")" "$(jesc "${rx:-}")" "$(jesc "${at:-}")" "$(jesc "$PLC_IF")" \
		"$(printf '%s' "$raw" | cut -c1-200 | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')")
}

nft_counter() {
	nft list counter inet fw4 "$1" 2>/dev/null |
		awk '{ for (i = 1; i <= NF; i++) if ($i == "packets") { print $(i + 1); exit } }'
}

collect_qos() {
	Q_PRIORITY=$(nft_counter avanza_lane_priority_hits || echo 0)
	Q_VIDEO=$(nft_counter avanza_lane_video_hits || echo 0)
	Q_BULK=$(nft_counter avanza_lane_bulk_hits || echo 0)
	Q_LATERAL=$(nft_counter avanza_lateral_blocked || echo 0)
	base=$(cat "$LATERAL_BASE_FILE" 2>/dev/null || echo 0)
	Q_LATERAL_DELTA=$((Q_LATERAL - base))
	[ "$Q_LATERAL_DELTA" -lt 0 ] && Q_LATERAL_DELTA=$Q_LATERAL
	echo "$Q_LATERAL" > "$LATERAL_BASE_FILE"
}

conntrack_digest_file() {
	: > "$RUN_DIR/digest.txt"
	[ -r /proc/net/nf_conntrack ] || return 0
	awk '{
		p = ""; s = ""; d = ""; dp = "-"; b = 0
		for (i = 1; i <= NF; i++) {
			t = $i
			if ((t == "tcp" || t == "udp" || t == "icmp") && p == "") p = t
			else if (t ~ /^src=/ && s == "") s = substr(t, 5)
			else if (t ~ /^dst=/ && d == "") d = substr(t, 5)
			else if (t ~ /^dport=/ && dp == "-") dp = substr(t, 7)
			else if (t ~ /^bytes=/) b += substr(t, 7)
		}
		if (s == "" || d == "" || p == "") next
		if (s !~ /^192\.168\./ && s !~ /^10\./ && s !~ /^172\.(1[6-9]|2[0-9]|3[01])\./) next
		k = p " " s " " d " " dp
		cnt[k]++
		byt[k] += b
	}
	END { for (k in cnt) printf "%s %d %d\n", k, cnt[k], byt[k] }' \
		/proc/net/nf_conntrack 2>/dev/null | sort -k6 -nr | head -n 24 > "$RUN_DIR/digest.txt"
}

build_payload() {
	digest_json=""
	while read -r p s d dp c b; do
		[ -n "${p:-}" ] || continue
		entry=$(printf '{"proto":"%s","src":"%s","dst":"%s","dport":"%s","conns":%s,"bytes":%s}' \
			"$(jesc "$p")" "$(jesc "$s")" "$(jesc "$d")" "$(jesc "$dp")" "${c:-0}" "${b:-0}")
		digest_json="$digest_json${digest_json:+,}$entry"
	done < "$RUN_DIR/digest.txt"

	events_json=""
	if [ -s "$EVENTS_FILE" ]; then
		while read -r line; do
			[ -n "$line" ] || continue
			events_json="$events_json${events_json:+,}$line"
		done < "$EVENTS_FILE"
		: > "$EVENTS_FILE"
	fi

	rb_pending="false"
	[ -f "$MARKER" ] && rb_pending="true"
	last_rb=$(cat "$RUN_DIR/last_rollback" 2>/dev/null || echo "")
	fw_ver=$(cat "$FW_VERSION_FILE" 2>/dev/null || echo "none")
	apply_state=$(cat "$APPLY_STATE_FILE" 2>/dev/null || echo "idle")
	sp="null"
	[ -s "$SPEEDTEST_RESULT" ] && sp=$(cat "$SPEEDTEST_RESULT")
	bb="null"
	if [ -s "$BACKUP_B64" ]; then bb="\"$(cat "$BACKUP_B64")\""; fi

	{
		printf '{'
		printf '"v":1,"device":"%s","role":"%s","ts":%s,"agent_version":"%s",' "$(jesc "$DEVICE_ID")" "$(jesc "$DEVICE_ROLE")" "$(date +%s)" "$AGENT_VERSION"
		printf '"wan":{"up":%s,"proto":"%s","addr":"%s","uptime":%s,"rx_errors":%s,"tx_errors":%s,"carrier_changes":%s},' \
			"${WAN_UP:-false}" "$(jesc "$WAN_PROTO")" "$(jesc "$WAN_ADDR")" "${WAN_UPTIME:-0}" "${RX_ERR:-0}" "${TX_ERR:-0}" "${CARRIER:-0}"
		printf '"sys":{"load":%s,"mem_total":%s,"mem_free":%s,"mem_available":%s,"uptime":%s,"overlay_pct":%s,"wifi_stations":%s,"openwrt_version":"%s"},' \
			"${SYS_LOAD:-0}" "${MEM_TOTAL:-0}" "${MEM_FREE:-0}" "${MEM_AVAIL:-0}" "${SYS_UPTIME:-0}" "${OVERLAY_PCT:-0}" "${WIFI_STATIONS:-0}" "$(jesc "${OPENWRT_VER:-}")"
		printf '"qos":{"priority_pkts":%s,"video_pkts":%s,"bulk_pkts":%s,"lateral_blocked_total":%s,"lateral_blocked_delta":%s},' \
			"${Q_PRIORITY:-0}" "${Q_VIDEO:-0}" "${Q_BULK:-0}" "${Q_LATERAL:-0}" "${Q_LATERAL_DELTA:-0}"
		printf '"ct":{"count":%s,"max":%s},' "${CT_COUNT:-0}" "${CT_MAX:-8192}"
		printf '"fdb":{%s,"delta":%s},' "$FDB_JSON" "${FDB_DELTA:-0}"
		printf '"plc":%s,' "$PLC_JSON"
		printf '"tunnel":"%s","speedtest":%s,"backup_b64":%s,' "$(jesc "${TUNNEL_STATE:-disabled}")" "$sp" "$bb"
		printf '"digest":[%s],"events":[%s],' "$digest_json" "$events_json"
		printf '"fleet":{"config_version":"%s","apply_state":"%s"},' "$(jesc "$fw_ver")" "$(jesc "$apply_state")"
		printf '"rollback":{"pending":%s,"last":"%s"}' "$rb_pending" "$(jesc "$last_rb")"
		printf '}'
	} > "$PAYLOAD_FILE"
}

sign_header() {
	file="$1"
	if [ -n "$AGENT_HMAC_KEY" ] && command -v openssl >/dev/null 2>&1; then
		sig=$(openssl dgst -sha256 -hmac "$AGENT_HMAC_KEY" -binary "$file" | hexdump -v -e '"%02x"')
		SIG_HDR="X-Avanza-Signature: t=$(date +%s),v1=$sig"
	else
		SIG_HDR="X-Avanza-Token: $AGENT_HMAC_KEY"
		log "WARN: openssl unavailable; static-token auth fallback"
	fi
}

sign_and_post() {
	[ -s "$PAYLOAD_FILE" ] || { log "empty payload; skip"; return 1; }
	sign_header "$PAYLOAD_FILE"
	uclient-fetch -q -O "$RESP_FILE" --timeout=25 \
		--header="$SIG_HDR" --header="Content-Type: application/json" \
		--header="X-Avanza-Device: $DEVICE_ID" \
		--post-file="$PAYLOAD_FILE" \
		"$ORCH_URL/api/telemetry/ingest" >/dev/null 2>&1
	rc=$?
	if [ $rc -ne 0 ] || [ ! -s "$RESP_FILE" ]; then
		log "ingest failed rc=$rc; last-known-good retained"
		return 1
	fi
	return 0
}

zone_of_ip() {
	case "$1" in
		192.168.10.*) echo "lan" ;;
		192.168.20.*) echo "media" ;;
		192.168.30.*) echo "iot" ;;
		192.168.40.*) echo "guest" ;;
		192.168.99.*) echo "fleet" ;;
		*) echo "" ;;
	esac
}

apply_lane() {
	ip="$1"; lane="$2"; ttl="${3:-900}"
	case "$ip" in *[!0-9.]*|"") log "reject malformed lane target: $ip"; return 1 ;; esac
	target_set=""
	case "$lane" in
		priority) target_set="avanza_lane_priority" ;;
		video)    target_set="avanza_lane_video" ;;
		bulk)     target_set="avanza_lane_bulk" ;;
		normal)   target_set="" ;;
		*) log "unknown lane '$lane' for $ip"; return 1 ;;
	esac
	for s in avanza_lane_priority avanza_lane_video avanza_lane_bulk; do
		[ "$s" = "$target_set" ] && continue
		nft delete element inet fw4 "$s" "{ $ip }" >/dev/null 2>&1
	done
	if [ -n "$target_set" ]; then
		if nft add element inet fw4 "$target_set" "{ $ip timeout ${ttl}s }" >/dev/null 2>&1; then
			log "lane applied: $ip -> $lane (ttl ${ttl}s)"
		else
			log "WARN: nft add element failed for $ip"; return 1
		fi
	else
		log "lane cleared: $ip -> best-effort"
	fi
}

apply_directives() {
	jsonfilter -i "$RESP_FILE" -e '@.directives[*]' 2>/dev/null | while read -r el; do
		[ -n "$el" ] || continue
		ip=$(printf '%s' "$el" | jsonfilter -e '@.ip' 2>/dev/null)
		lane=$(printf '%s' "$el" | jsonfilter -e '@.lane' 2>/dev/null)
		ttl=$(printf '%s' "$el" | jsonfilter -e '@.ttl' 2>/dev/null)
		[ -n "$ip" ] && apply_lane "$ip" "$lane" "${ttl:-900}"
	done
}

snapshot_config() {
	stamp=$(date +%Y%m%d-%H%M%S)
	mkdir -p "$RB_DIR/$stamp" || { log "cannot snapshot; aborting change"; return 1; }
	for f in firewall sqm umdns network wireless dhcp; do
		[ -f "/etc/config/$f" ] && cp "/etc/config/$f" "$RB_DIR/$stamp/" 2>/dev/null
	done
	echo "$stamp" > "$RUN_DIR/last_snap"
	prune_backups "$RB_KEEP"
	log "snapshot taken: $stamp"
}

arm_rollback() {
	snap=$(cat "$RUN_DIR/last_snap" 2>/dev/null || echo "")
	[ -n "$snap" ] || return 1
	printf '%s %s\n' "$snap" "$(date +%s)" > "$MARKER"
	log "rollback ARMED: $snap window=${RB_WINDOW}s"
}

confirm_rollback() {
	[ -f "$MARKER" ] || return 0
	snap=$(cut -d' ' -f1 "$MARKER")
	rm -f "$MARKER"
	log "rollback DISARMED: change survived probes ($snap)"
}

health_probe() {
	# 3-point ping sweep + DNS/HTTPS + tunnel validation
	fails=0
	gw=$(ip route show default 2>/dev/null | awk '{ print $3; exit }')
	if [ -n "$gw" ]; then
		ping -c 2 -W 2 "$gw" >/dev/null 2>&1 || fails=$((fails + 1))
	else
		fails=$((fails + 1))
	fi
	ping -c 2 -W 2 "$FLEET_PEER_IP" >/dev/null 2>&1 || log "probe: fleet peer $FLEET_PEER_IP unreachable (counted)"
	ping -c 2 -W 2 1.1.1.1 >/dev/null 2>&1 || fails=$((fails + 1))
	uclient-fetch -q -O /dev/null --timeout=10 "$ORCH_URL/health" >/dev/null 2>&1 || fails=$((fails + 1))
	if [ "$TUNNEL_ENABLED" = "1" ] && command -v cloudflared >/dev/null 2>&1; then
		pgrep cloudflared >/dev/null 2>&1 || fails=$((fails + 1))
	fi
	[ "$fails" -ge 2 ] && return 1
	return 0
}

do_rollback() {
	snap="$1"
	if [ ! -d "$RB_DIR/$snap" ]; then
		log "rollback source missing ($snap); disarming"
		rm -f "$MARKER"
		return 1
	fi
	log "ROLLBACK EXECUTING: $snap"
	cp -f "$RB_DIR/$snap/"* /etc/config/ 2>/dev/null
	for svc in firewall sqm umdns network dhcp; do
		[ -x "/etc/init.d/$svc" ] && "/etc/init.d/$svc" restart >/dev/null 2>&1
	done
	rm -f "$MARKER" "$TEMP_ACCESS" "$PAUSE_FILE"
	echo "$snap" > "$RUN_DIR/last_rollback"
	echo "rolled_back:$snap" > "$APPLY_STATE_FILE"
	log "ROLLBACK COMPLETE: $snap"
}

watchdog_check() {
	[ -f "$MARKER" ] || return 0
	read -r snap armed < "$MARKER" || { rm -f "$MARKER"; return 0; }
	now=$(date +%s)
	age=$((now - armed))
	if [ "$age" -lt "$RB_WINDOW" ]; then
		health_probe || { log "probe FAILED inside window (age=${age}s)"; do_rollback "$snap"; }
		return 0
	fi
	if health_probe; then confirm_rollback; else log "probe FAILED at expiry"; do_rollback "$snap"; fi
}

apply_temp_access() {
	jsonfilter -i "$RESP_FILE" -e '@.temp_access[*]' 2>/dev/null | while read -r el; do
		[ -n "$el" ] || continue
		phone=$(printf '%s' "$el" | jsonfilter -e '@.phone_ip' 2>/dev/null)
		devip=$(printf '%s' "$el" | jsonfilter -e '@.device_ip' 2>/dev/null)
		ttl=$(printf '%s' "$el" | jsonfilter -e '@.ttl' 2>/dev/null)
		[ -n "$phone" ] && [ -n "$devip" ] || continue
		ttl="${ttl:-900}"
		dzone=$(zone_of_ip "$devip")
		[ -n "$dzone" ] || { log "temp-access: unknown zone $devip"; continue; }
		secid="rule_avanza_tmpaccess_$(echo "$devip" | tr '.' '_')"
		if ! uci -q get "firewall.$secid" >/dev/null 2>&1; then
			snapshot_config || continue
			uci set "firewall.$secid=firewall.rule"
			uci set "firewall.$secid.name=Avanza-TempAccess-$devip"
			uci set "firewall.$secid.src=lan"
			uci set "firewall.$secid.dest=$dzone"
			uci set "firewall.$secid.src_ip=$phone"
			uci set "firewall.$secid.dest_ip=$devip"
			uci set "firewall.$secid.proto=all"
			uci set "firewall.$secid.target=ACCEPT"
			uci commit firewall
			/etc/init.d/firewall reload >/dev/null 2>&1
			arm_rollback
			log "temp-access GRANTED: $phone -> $devip (ttl ${ttl}s)"
		fi
		deadline=$(( $(date +%s) + ttl ))
		[ -f "$TEMP_ACCESS" ] && grep -q "^$secid " "$TEMP_ACCESS" && sed -i "/^$secid /d" "$TEMP_ACCESS"
		echo "$secid $deadline" >> "$TEMP_ACCESS"
	done
}

expire_temp_access() {
	[ -f "$TEMP_ACCESS" ] || return 0
	now=$(date +%s); changed=0
	: > "$TEMP_ACCESS.new"
	while read -r secid deadline; do
		[ -n "$secid" ] || continue
		if [ "$now" -ge "$deadline" ]; then
			uci -q delete "firewall.$secid" && changed=1
			log "temp-access EXPIRED: firewall.$secid"
		else
			echo "$secid $deadline" >> "$TEMP_ACCESS.new"
		fi
	done < "$TEMP_ACCESS"
	mv "$TEMP_ACCESS.new" "$TEMP_ACCESS"
	[ "$changed" -eq 1 ] && { uci commit firewall; /etc/init.d/firewall reload >/dev/null 2>&1; }
}

do_backup() {
	tar czf "$RUN_DIR/backup.tar.gz" -C / etc/config 2>/dev/null || { log "backup tar failed"; return 1; }
	base64 < "$RUN_DIR/backup.tar.gz" | tr -d '\n' > "$BACKUP_B64"
	rm -f "$RUN_DIR/backup.tar.gz"
	size=$(wc -c < "$BACKUP_B64")
	if [ "$size" -gt 400000 ]; then
		rm -f "$BACKUP_B64"; log "backup too large (${size}B) - refused"; return 1
	fi
	log "backup created ${size}B b64 - ships next cycle"
}

do_restore() {
	b64="$1"
	[ -n "$b64" ] || { log "restore: empty"; return 1; }
	printf '%s' "$b64" | base64 -d > "$RUN_DIR/restore.tar.gz" 2>/dev/null ||
		{ log "restore: decode failed"; rm -f "$RUN_DIR/restore.tar.gz"; return 1; }
	tar tzf "$RUN_DIR/restore.tar.gz" >/dev/null 2>&1 ||
		{ log "restore: corrupt archive rejected"; rm -f "$RUN_DIR/restore.tar.gz"; return 1; }
	snapshot_config || { rm -f "$RUN_DIR/restore.tar.gz"; return 1; }
	tar xzf "$RUN_DIR/restore.tar.gz" -C / 2>/dev/null ||
		{ log "restore: extract failed"; rm -f "$RUN_DIR/restore.tar.gz"; return 1; }
	rm -f "$RUN_DIR/restore.tar.gz"
	for svc in firewall sqm umdns network dhcp; do
		[ -x "/etc/init.d/$svc" ] && "/etc/init.d/$svc" reload >/dev/null 2>&1
	done
	arm_rollback
	log "restore COMPLETE; rollback armed"
}

do_pause() {
	ip="$1"; until_ts="${2:-0}"
	z=$(zone_of_ip "$ip")
	[ -n "$z" ] || { log "pause: unknown zone $ip"; return 1; }
	secid="rule_avanza_pause_$(echo "$ip" | tr '.' '_')"
	if ! uci -q get "firewall.$secid" >/dev/null 2>&1; then
		snapshot_config || return 1
		uci set "firewall.$secid=firewall.rule"
		uci set "firewall.$secid.name=Avanza-Pause-$ip"
		uci set "firewall.$secid.src=$z"
		uci set "firewall.$secid.src_ip=$ip"
		uci set "firewall.$secid.proto=all"
		uci set "firewall.$secid.target=REJECT"
		uci commit firewall
		/etc/init.d/firewall reload >/dev/null 2>&1
		arm_rollback
	fi
	[ -f "$PAUSE_FILE" ] && grep -q "^$secid " "$PAUSE_FILE" && sed -i "/^$secid /d" "$PAUSE_FILE"
	echo "$secid $until_ts $ip" >> "$PAUSE_FILE"
	log "parental PAUSE: $ip (zone $z) until=$until_ts"
}

do_resume() {
	ip="$1"
	secid="rule_avanza_pause_$(echo "$ip" | tr '.' '_')"
	changed=0
	uci -q get "firewall.$secid" >/dev/null 2>&1 && { uci -q delete "firewall.$secid"; uci commit firewall; changed=1; }
	if [ -f "$PAUSE_FILE" ] && grep -q "^$secid " "$PAUSE_FILE"; then
		sed -i "/^$secid /d" "$PAUSE_FILE"; changed=1
	fi
	[ "$changed" -eq 1 ] && { /etc/init.d/firewall reload >/dev/null 2>&1; log "parental RESUME: $ip"; }
}

expire_pauses() {
	[ -f "$PAUSE_FILE" ] || return 0
	now=$(date +%s)
	: > "$PAUSE_FILE.new"
	while read -r secid until_ts ip; do
		[ -n "$secid" ] || continue
		if [ "$until_ts" -gt 0 ] 2>/dev/null && [ "$now" -ge "$until_ts" ]; then
			do_resume "$ip"
		else
			echo "$secid $until_ts $ip" >> "$PAUSE_FILE.new"
		fi
	done < "$PAUSE_FILE"
	mv "$PAUSE_FILE.new" "$PAUSE_FILE"
}

apply_fleet_bundle() {
	ver_json=$(jsonfilter -i "$RESP_FILE" -e '@.config.version' 2>/dev/null)
	[ -n "$ver_json" ] && [ "$ver_json" != "null" ] || return 0
	token=$(printf '%s' "$ver_json" | jsonfilter -e '@.token' 2>/dev/null)
	sha=$(printf '%s' "$ver_json" | jsonfilter -e '@.sha256' 2>/dev/null)
	cur=$(cat "$FW_VERSION_FILE" 2>/dev/null || echo "none")
	[ -n "$token" ] || return 0
	[ "$token" = "$cur" ] && return 0
	log "GitOps: config version $cur -> $token (sha256 ${sha:-none})"
	echo "downloading:$token" > "$APPLY_STATE_FILE"
	bundle="$RUN_DIR/bundle.tar.gz"
	printf '' > "$bundle"
	uclient-fetch -q -O "$bundle" --timeout=60 \
		--header="X-Avanza-Token: $AGENT_HMAC_KEY" \
		--header="X-Avanza-Device: $DEVICE_ID" \
		"$ORCH_URL/api/fleet/bundle?device=primary" >/dev/null 2>&1 ||
		{ log "bundle download failed; retry next cycle"; rm -f "$bundle"; echo "download_failed:$token" > "$APPLY_STATE_FILE"; return 1; }
	if [ -n "$sha" ] && command -v sha256sum >/dev/null 2>&1; then
		got=$(sha256sum "$bundle" | cut -d' ' -f1)
		if [ "$got" != "$sha" ]; then
			log "SECURITY: sha256 mismatch ($got != $sha) - REJECTED"
			rm -f "$bundle"
			echo "sha_mismatch:$token" > "$APPLY_STATE_FILE"
			return 1
		fi
		log "sha256 verified: $got"
	fi
	staging="$RUN_DIR/staging"
	rm -rf "$staging"; mkdir -p "$staging"
	tar xzf "$bundle" -C "$staging" 2>/dev/null || { log "extract failed"; rm -rf "$staging" "$bundle"; echo "extract_failed:$token" > "$APPLY_STATE_FILE"; return 1; }
	rm -f "$bundle"
	[ -f "$staging/scripts/transpile_config.sh" ] || { log "bundle lacks transpiler; rejected"; rm -rf "$staging"; echo "invalid_bundle:$token" > "$APPLY_STATE_FILE"; return 1; }
	snapshot_config || { rm -rf "$staging"; return 1; }
	snap=$(cat "$RUN_DIR/last_snap")
	printf '%s %s\n' "$snap" "$(date +%s)" > "$MARKER"
	log "rollback ARMED ($snap); applying $token via transpiler"
	echo "applying:$token:$snap" > "$APPLY_STATE_FILE"
	if sh "$staging/scripts/transpile_config.sh" --source "$staging/configs" --apply >>"$LOG_FILE" 2>&1; then
		echo "$token" > "$FW_VERSION_FILE"
		echo "applied:$token:$snap" > "$APPLY_STATE_FILE"
		log "GitOps: $token applied; watchdog validating ${RB_WINDOW}s (3-point sweep + DNS/HTTPS + tunnel)"
	else
		log "GitOps: apply FAILED; immediate rollback to $snap"
		do_rollback "$snap"
	fi
	rm -rf "$staging"
}

handle_actions() {
	jsonfilter -i "$RESP_FILE" -e '@.actions[*]' 2>/dev/null | while read -r el; do
		[ -n "$el" ] || continue
		atype=$(printf '%s' "$el" | jsonfilter -e '@.type' 2>/dev/null)
		case "$atype" in
			speedtest)
				log "action: speedtest"
				[ -x "$SPEEDTEST_PROG" ] && ("$SPEEDTEST_PROG" >/dev/null 2>&1 &) || log "WARN: $SPEEDTEST_PROG missing"
				;;
			backup) do_backup ;;
			restore)
				rb64=$(printf '%s' "$el" | jsonfilter -e '@.b64' 2>/dev/null)
				do_restore "$rb64"
				;;
			pause)
				aip=$(printf '%s' "$el" | jsonfilter -e '@.ip' 2>/dev/null)
				auntil=$(printf '%s' "$el" | jsonfilter -e '@.until' 2>/dev/null)
				[ -n "$aip" ] && do_pause "$aip" "${auntil:-0}"
				;;
			resume)
				aip=$(printf '%s' "$el" | jsonfilter -e '@.ip' 2>/dev/null)
				[ -n "$aip" ] && do_resume "$aip"
				;;
			*) log "unknown action '$atype' ignored" ;;
		esac
	done
}

note_outage() {
	st=$(jsonfilter -i "$RESP_FILE" -e '@.outage.state' 2>/dev/null || echo "")
	[ -n "$st" ] || return 0
	prev=$(cat "$OUTAGE_STATE_FILE" 2>/dev/null || echo "")
	if [ "$st" != "$prev" ]; then
		log "outage oracle: $prev -> $st"
		echo "$st" > "$OUTAGE_STATE_FILE"
	fi
}

trap 'log "agent v2 stopping (signal)"; exit 0' TERM INT

require_time
log "avanza agent v$AGENT_VERSION ($DEVICE_ROLE/$DEVICE_ID) start: interval=${INTERVAL}s plc=${PLC_ENABLED}/${PLC_IF} tunnel=${TUNNEL_ENABLED} orch=$ORCH_URL"

while true; do
	watchdog_check
	expire_temp_access
	expire_pauses
	storage_guard
	tunnel_guard
	collect_wan
	collect_system
	collect_qos
	collect_fdb
	collect_plc
	conntrack_digest_file
	build_payload
	if sign_and_post; then
		rm -f "$SPEEDTEST_RESULT" "$BACKUP_B64"
		apply_fleet_bundle
		apply_directives
		apply_temp_access
		handle_actions
		note_outage
	else
		log "cycle failed (offline?) - fail-safe: lanes/config untouched"
	fi
	sleep "$INTERVAL"
done
