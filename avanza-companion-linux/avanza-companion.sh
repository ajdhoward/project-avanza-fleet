#!/bin/sh
# PROJECT AVANZA / avanza-companion-linux / avanza-companion.sh
# LAN companion daemon for Linux machines: registers the host in the device
# registry, auto-boosts to the EF priority lane during video calls (Meeting
# Mode), releases the boost afterwards, and surfaces outage verdicts on the
# desktop. Talks only to the orchestrator (app-token auth). POSIX sh + curl.
set -u

ENV_FILE="${AVANZA_ENV:-/etc/avanza/companion.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

: "${ORCH_URL:=https://avanza-edge-orchestrator.local.workers.dev}"
: "${APP_TOKEN:=}"
: "${INTERVAL:=30}"
: "${BOOST_TTL:=3600}"
: "${SELF_IP:=}"
: "${GRACE_CYCLES:=2}"

HOSTNAME_STR=$(hostname -s 2>/dev/null || echo linux-host)
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/avanza"
mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/companion.log"

log() {
	line="$(date '+%F %T') $*"
	echo "$line" >> "$LOG_FILE"
	command -v logger >/dev/null 2>&1 && logger -t avanza-companion -- "$line" 2>/dev/null
}

die() { log "FATAL: $*"; echo "avanza-companion: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
[ -n "$APP_TOKEN" ] || die "APP_TOKEN not set (see $ENV_FILE)"

detect_self_ip() {
	[ -n "$SELF_IP" ] && { echo "$SELF_IP"; return 0; }
	ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit } }'
}

api() {
	method="$1"; path="$2"; body="${3:-}"
	if [ -n "$body" ]; then
		curl -sS -m 20 -X "$method" \
			-H "content-type: application/json" \
			-H "x-avanza-app-token: $APP_TOKEN" \
			--data "$body" "$ORCH_URL$path" 2>>"$LOG_FILE"
	else
		curl -sS -m 20 -X "$method" \
			-H "x-avanza-app-token: $APP_TOKEN" "$ORCH_URL$path" 2>>"$LOG_FILE"
	fi
}

notify_desktop() {
	command -v notify-send >/dev/null 2>&1 &&
		notify-send -a "Avanza" -u critical "$1" "$2" 2>/dev/null
	log "notify: $1 — $2"
}

meeting_active() {
	pgrep -f -i "zoom|teams|webex|slack.*call|google-chrome.*meet" >/dev/null 2>&1 && return 0
	command -v ss >/dev/null 2>&1 &&
		ss -tun 2>/dev/null | grep -Eq ':(3478|3479|5060|5061)\b' && return 0
	return 1
}

register_host() {
	ip="$1"
	os_str=$(uname -sr)
	api POST /api/control/register \
		"{\"ip\":\"$ip\",\"hostname\":\"$HOSTNAME_STR\",\"os\":\"$os_str\"}" >/dev/null &&
		log "registered $HOSTNAME_STR ($ip, $os_str)"
}

boost() {
	ip="$1"
	api POST /api/control/lane \
		"{\"ip\":\"$ip\",\"lane\":\"priority\",\"ttl\":$BOOST_TTL}" >/dev/null &&
		{ log "MEETING MODE ON: $ip → EF priority lane (ttl ${BOOST_TTL}s)"; notify_desktop "Avanza: Meeting Mode" "Priority lane granted until call ends (+${BOOST_TTL}s cap)."; }
}

unboost() {
	ip="$1"
	api POST /api/control/lane \
		"{\"ip\":\"$ip\",\"lane\":\"normal\",\"ttl\":60}" >/dev/null &&
		{ log "MEETING MODE OFF: $ip → static baseline"; notify_desktop "Avanza: boost released" "Back to normal lane."; }
}

check_outage_once() {
	st=$(api GET /api/outage/status | sed -n 's/.*"state":"\([A-Z_]*\)".*/\1/p')
	if [ -n "$st" ] && [ "$st" != "HEALTHY" ] && [ "$st" != "$LAST_OUTAGE" ]; then
		notify_desktop "Avanza network: $st" "$(api GET /api/outage/status | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p' | head -c 160)"
	fi
	LAST_OUTAGE="${st:-$LAST_OUTAGE}"
}

MY_IP=$(detect_self_ip)
[ -n "$MY_IP" ] || die "cannot detect local IP (set SELF_IP in $ENV_FILE)"

log "avanza-companion starting: host=$HOSTNAME_STR ip=$MY_IP orch=$ORCH_URL interval=${INTERVAL}s"
register_host "$MY_IP"

BOOSTED=0
CLEAN=0
LAST_OUTAGE=""
OUTAGE_TICK=0

trap 'log "stopping"; [ "$BOOSTED" -eq 1 ] && unboost "$MY_IP"; exit 0' TERM INT

while true; do
	if meeting_active; then
		CLEAN=0
		if [ "$BOOSTED" -eq 0 ]; then
			boost "$MY_IP"
			BOOSTED=1
			register_host "$MY_IP"
		fi
	else
		if [ "$BOOSTED" -eq 1 ]; then
			CLEAN=$((CLEAN + 1))
			if [ "$CLEAN" -ge "$GRACE_CYCLES" ]; then
				unboost "$MY_IP"
				BOOSTED=0
				CLEAN=0
			fi
		fi
	fi
	OUTAGE_TICK=$((OUTAGE_TICK + 1))
	if [ $((OUTAGE_TICK % 60)) -eq 1 ]; then
		check_outage_once
	fi
	sleep "$INTERVAL"
done
