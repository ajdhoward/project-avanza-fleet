#!/bin/sh
# PROJECT AVANZA / avanza-router-secondary / scripts/secondary_agent.sh
# Headless L2 switch node agent (TD-W8968 v3 · BCM6318 · 64MB RAM).
# Non-resident discipline: one sleeping ash loop, forked helpers are transient.
# Duties: meminfo/uptime/port-error telemetry, bridge-FDB client presence,
# logread-delta syslog pipe to the Worker (HTTPS, HMAC), GitOps bundle apply
# with snapshot-first rollback, uplink probe toward the primary (192.168.99.1).
set -u

AGENT_VERSION="2.0.0"
ENV_FILE="/etc/avanza/secondary.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

: "${ORCH_URL:=https://avanza-edge-orchestrator.local.workers.dev}"
: "${AGENT_HMAC_KEY:=}"
: "${DEVICE_ID:=avanza-switch}"
: "${INTERVAL:=120}"
: "${PRIMARY_IP:=192.168.99.1}"
: "${BRIDGE:=br-switch}"
: "${RB_DIR:=/overlay/avanza/rollback}"
: "${RB_WINDOW:=600}"
: "${MIN_EPOCH:=1767225600}"

RUN_DIR="/tmp/avanza"
LOCK_FILE="$RUN_DIR/agent.lock"
PAYLOAD_FILE="$RUN_DIR/payload.json"
RESP_FILE="$RUN_DIR/response.json"
SYSLOG_FILE="$RUN_DIR/syslog.txt"
SYSLOG_PREV="$RUN_DIR/syslog.prev"
MARKER="$RUN_DIR/pending_rollback"
FW_VERSION_FILE="/etc/avanza/fleet_version"
LOG_FILE="$RUN_DIR/agent.log"

mkdir -p "$RUN_DIR" "$RB_DIR" 2>/dev/null

log() {
	msg="$(date '+%Y-%m-%dT%H:%M:%S') $*"
	logger -t avanza-switch -- "$msg" 2>/dev/null
	echo "$msg" >> "$LOG_FILE" 2>/dev/null
	size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
	[ "$size" -gt 32768 ] && tail -c 16384 "$LOG_FILE" > "$LOG_FILE.t" && mv "$LOG_FILE.t" "$LOG_FILE"
}

exec 9>"$LOCK_FILE" 2>/dev/null
command -v flock >/dev/null 2>&1 && { flock -n 9 || { echo "secondary agent already running"; exit 0; }; }

jesc() { printf '%s' "$1" | tr '\n\t\r' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

require_time() {
	i=0
	while [ "$(date +%s)" -lt "$MIN_EPOCH" ]; do
		i=$((i + 1))
		[ "$i" -gt 8 ] && { log "WARN: clock unsynced after 8 attempts; continuing"; return 0; }
		ntpd -n -q -p "$PRIMARY_IP" -p 0.openwrt.pool.ntp.org >/dev/null 2>&1
		sleep 4
	done
}

port_errors_json() {
	out=""
	for p in lan1 lan2 lan3 lan4; do
		d="/sys/class/net/$p"
		[ -d "$d" ] || continue
		rx=$(cat "$d/statistics/rx_errors" 2>/dev/null || echo 0)
		tx=$(cat "$d/statistics/tx_errors" 2>/dev/null || echo 0)
		cr=$(cat "$d/statistics/collisions" 2>/dev/null || echo 0)
		entry=$(printf '{"port":"%s","rx_errors":%s,"tx_errors":%s,"collisions":%s}' "$p" "$rx" "$tx" "$cr")
		out="$out${out:+,}$entry"
	done
	echo "$out"
}

collect() {
	MEM_TOTAL=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
	MEM_AVAIL=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
	LOAD=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
	UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
	FDB_COUNT=0
	command -v bridge >/dev/null 2>&1 &&
		FDB_COUNT=$(bridge fdb show br "$BRIDGE" 2>/dev/null | grep -vc 'permanent\|self' || echo 0)
	UP_UP="false"
	ping -c 1 -W 2 "$PRIMARY_IP" >/dev/null 2>&1 && UP_UP="true"
	CT_COUNT=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 0)
}

syslog_batch() {
	: > "$SYSLOG_FILE.new"
	logread 2>/dev/null | tail -n 120 > "$SYSLOG_FILE.new"
	if [ -f "$SYSLOG_PREV" ]; then
		awk 'NR==FNR { seen[$0] = 1; next } !($0 in seen)' "$SYSLOG_PREV" "$SYSLOG_FILE.new" | tail -n 60 > "$SYSLOG_FILE"
	else
		tail -n 20 "$SYSLOG_FILE.new" > "$SYSLOG_FILE"
	fi
	mv "$SYSLOG_FILE.new" "$SYSLOG_PREV"
	[ -s "$SYSLOG_FILE" ] || return 1
	lines=""
	count=0
	while IFS= read -r ln; do
		[ -n "$ln" ] || continue
		count=$((count + 1))
		lines="$lines${lines:+,}\"$(jesc "$ln")\""
	done < "$SYSLOG_FILE"
	: > "$SYSLOG_FILE"
	printf '{"device":"%s","lines":[%s]}' "$(jesc "$DEVICE_ID")" "$lines" > "$RUN_DIR/syslog_payload.json"
	return 0
}

sign() {
	file="$1"
	if [ -n "$AGENT_HMAC_KEY" ] && command -v openssl >/dev/null 2>&1; then
		sig=$(openssl dgst -sha256 -hmac "$AGENT_HMAC_KEY" -binary "$file" | hexdump -v -e '"%02x"')
		SIG_HDR="X-Avanza-Signature: t=$(date +%s),v1=$sig"
	else
		SIG_HDR="X-Avanza-Token: $AGENT_HMAC_KEY"
	fi
}

post_syslog() {
	syslog_batch || return 0
	sign "$RUN_DIR/syslog_payload.json"
	uclient-fetch -q -O /dev/null --timeout=20 \
		--header="$SIG_HDR" --header="Content-Type: application/json" \
		--post-file="$RUN_DIR/syslog_payload.json" \
		"$ORCH_URL/api/fleet/syslog" >/dev/null 2>&1 ||
		log "WARN: syslog batch rejected/unreachable (kept in ring for next cycle)"
}

build_payload() {
	fw_ver=$(cat "$FW_VERSION_FILE" 2>/dev/null || echo "none")
	rb_pending="false"
	[ -f "$MARKER" ] && rb_pending="true"
	ports=$(port_errors_json)
	{
		printf '{'
		printf '"v":1,"device":"%s","ts":%s,"agent_version":"%s","role":"secondary",' "$(jesc "$DEVICE_ID")" "$(date +%s)" "$AGENT_VERSION"
		printf '"wan":{"up":%s,"proto":"fleet-l2","addr":"%s","uptime":%s,"rx_errors":0,"tx_errors":0,"carrier_changes":0},' "$UP_UP" "$PRIMARY_IP" "$UPTIME"
		printf '"sys":{"load":%s,"mem_total":%s,"mem_free":%s,"uptime":%s,"overlay_pct":0,"wifi_stations":0,"mem_available":%s,"openwrt_version":"%s"},' \
			"$LOAD" $((MEM_TOTAL * 1024)) $((MEM_TOTAL * 1024)) "$UPTIME" $((MEM_AVAIL * 1024)) "$(jesc "$(sed -n 's/^DISTRIB_RELEASE=.*/\1/p' /etc/openwrt_release 2>/dev/null)")"
		printf '"qos":{"priority_pkts":0,"video_pkts":0,"bulk_pkts":0,"lateral_blocked_total":0,"lateral_blocked_delta":0},'
		printf '"tunnel":"n/a","digest":[],"events":[],'
		printf '"fdb":{"switch":%s},"ct":{"count":%s},"ports":[%s],' "${FDB_COUNT:-0}" "${CT_COUNT:-0}" "$ports"
		printf '"fleet":{"config_version":"%s","rollback_pending":%s}' "$(jesc "$fw_ver")" "$rb_pending"
		printf '}'
	} > "$PAYLOAD_FILE"
}

sign_and_post() {
	sign "$PAYLOAD_FILE"
	uclient-fetch -q -O "$RESP_FILE" --timeout=25 \
		--header="$SIG_HDR" --header="Content-Type: application/json" \
		--header="X-Avanza-Device: $DEVICE_ID" \
		--post-file="$PAYLOAD_FILE" \
		"$ORCH_URL/api/telemetry/ingest" >/dev/null 2>&1
	rc=$?
	{ [ $rc -ne 0 ] || [ ! -s "$RESP_FILE" ]; } && { log "ingest failed rc=$rc"; return 1; }
	return 0
}

snapshot_config() {
	stamp=$(date +%Y%m%d-%H%M%S)
	mkdir -p "$RB_DIR/$stamp" || return 1
	for f in network firewall system dropbear; do
		[ -f "/etc/config/$f" ] && cp "/etc/config/$f" "$RB_DIR/$stamp/"
	done
	echo "$stamp" > "$RUN_DIR/last_snap"
	total=$(ls -1 "$RB_DIR" | wc -l)
	[ "$total" -gt 3 ] && ls -1 "$RB_DIR" | sort | head -n "$((total - 3))" | while read -r s; do rm -rf "$RB_DIR/$s"; done
	return 0
}

health_probe() {
	fails=0
	ping -c 2 -W 2 "$PRIMARY_IP" >/dev/null 2>&1 || fails=$((fails + 1))
	bridge fdb show br "$BRIDGE" >/dev/null 2>&1 || fails=$((fails + 1))
	uclient-fetch -q -O /dev/null --timeout=10 "$ORCH_URL/health" >/dev/null 2>&1 || fails=$((fails + 1))
	[ "$fails" -ge 2 ] && return 1
	return 0
}

do_rollback() {
	snap="$1"
	[ -d "$RB_DIR/$snap" ] || { log "rollback source missing ($snap)"; rm -f "$MARKER"; return 1; }
	log "ROLLBACK: restoring $snap"
	cp -f "$RB_DIR/$snap/"* /etc/config/ 2>/dev/null
	[ -x /etc/init.d/network ] && /etc/init.d/network restart >/dev/null 2>&1
	[ -x /etc/init.d/firewall ] && /etc/init.d/firewall restart >/dev/null 2>&1
	rm -f "$MARKER"
	echo "$snap" > "$RUN_DIR/last_rollback"
	log "ROLLBACK COMPLETE ($snap)"
}

watchdog_check() {
	[ -f "$MARKER" ] || return 0
	read -r snap armed < "$MARKER" || { rm -f "$MARKER"; return 0; }
	now=$(date +%s)
	age=$((now - armed))
	if [ "$age" -lt "$RB_WINDOW" ]; then
		health_probe || { log "probe failed inside window (age=${age}s)"; do_rollback "$snap"; }
		return 0
	fi
	if health_probe; then
		rm -f "$MARKER"
		log "config change confirmed healthy; rollback disarmed ($snap)"
	else
		do_rollback "$snap"
	fi
}

apply_fleet_bundle() {
	ver_json=$(jsonfilter -i "$RESP_FILE" -e '@.config.version' 2>/dev/null)
	[ -n "$ver_json" ] && [ "$ver_json" != "null" ] || return 0
	token=$(printf '%s' "$ver_json" | jsonfilter -e '@.token' 2>/dev/null)
	sha=$(printf '%s' "$ver_json" | jsonfilter -e '@.sha256' 2>/dev/null)
	cur=$(cat "$FW_VERSION_FILE" 2>/dev/null || echo "none")
	[ -n "$token" ] || return 0
	[ "$token" = "$cur" ] && return 0
	log "GitOps: fleet config version $cur -> $token (sha256 ${sha:-unverified})"
	bundle="$RUN_DIR/bundle.tar.gz"
	printf '' > "$bundle"
	uclient-fetch -q -O "$bundle" --timeout=60 \
		--header="X-Avanza-Token: $AGENT_HMAC_KEY" \
		--header="X-Avanza-Device: $DEVICE_ID" \
		"$ORCH_URL/api/fleet/bundle?device=secondary" >/dev/null 2>&1 ||
		{ log "bundle download failed; will retry next cycle"; rm -f "$bundle"; return 1; }
	if [ -n "$sha" ] && command -v sha256sum >/dev/null 2>&1; then
		got=$(sha256sum "$bundle" | cut -d' ' -f1)
		if [ "$got" != "$sha" ]; then
			log "SECURITY: sha256 mismatch (got $got want $sha) - bundle rejected"
			rm -f "$bundle"
			return 1
		fi
	fi
	staging="$RUN_DIR/staging"
	rm -rf "$staging"; mkdir -p "$staging"
	tar xzf "$bundle" -C "$staging" 2>/dev/null || { log "bundle extract failed"; rm -rf "$staging" "$bundle"; return 1; }
	rm -f "$bundle"
	[ -f "$staging/scripts/transpile_network.sh" ] || { log "bundle missing transpiler; rejected"; rm -rf "$staging"; return 1; }
	snapshot_config || { rm -rf "$staging"; return 1; }
	snap=$(cat "$RUN_DIR/last_snap")
	printf '%s %s\n' "$snap" "$(date +%s)" > "$MARKER"
	log "rollback ARMED ($snap, window ${RB_WINDOW}s); applying bundle"
	if sh "$staging/scripts/transpile_network.sh" --source "$staging/configs" --apply >>"$LOG_FILE" 2>&1; then
		echo "$token" > "$FW_VERSION_FILE"
		log "GitOps: bundle $token applied; watchdog verifying for ${RB_WINDOW}s"
	else
		log "GitOps: apply FAILED; rolling back to $snap"
		do_rollback "$snap"
	fi
	rm -rf "$staging"
}

trap 'log "secondary agent stopping"; exit 0' TERM INT

require_time
log "avanza secondary agent v$AGENT_VERSION starting: device=$DEVICE_ID interval=${INTERVAL}s orch=$ORCH_URL"

CYCLE=0
while true; do
	watchdog_check
	collect
	build_payload
	if sign_and_post; then
		apply_fleet_bundle
	fi
	CYCLE=$((CYCLE + 1))
	[ $((CYCLE % 2)) -eq 0 ] && post_syslog
	sleep "$INTERVAL"
done
