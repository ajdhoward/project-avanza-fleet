#!/bin/sh
# PROJECT AVANZA / avanza-router-core / scripts/speedtest.sh
# Dependency-free WAN speed diagnostic for busybox (no Ookla binary exists for
# MIPS): uclient-fetch against speed.cloudflare.com, /proc/uptime timing.
# Writes JSON result to /tmp/avanza/speedtest.json; the agent ships it up on
# the next telemetry cycle when a speedtest action was requested.
set -u

OUT="/tmp/avanza/speedtest.json"
UP_BIN="/tmp/avanza/speedtest_up.bin"
BASE="https://speed.cloudflare.com"
DOWN_BYTES="${DOWN_BYTES:-25000000}"
UP_BYTES=4194304

mkdir -p /tmp/avanza
rm -f "$OUT"

tick() { awk '{ print $1 }' /proc/uptime; }

t0=$(tick)
uclient-fetch -q -O /dev/null --timeout=45 "$BASE/__down?bytes=$DOWN_BYTES" || {
	echo '{"error":"download leg failed","ts":'"$(date +%s)"'}' > "$OUT"
	exit 1
}
t1=$(tick)

dd if=/dev/zero of="$UP_BIN" bs=4096 count=$((UP_BYTES / 4096)) 2>/dev/null
t2=$(tick)
UP_FAIL=0
uclient-fetch -q -O /dev/null --timeout=45 --post-file="$UP_BIN" "$BASE/__up" || UP_FAIL=1
t3=$(tick)
rm -f "$UP_BIN"

t4=$(tick)
uclient-fetch -q -O /dev/null --timeout=15 "$BASE/__down?bytes=0" || true
t5=$(tick)

eval "$(awk -v a="$t0" -v b="$t1" -v c="$t2" -v d="$t3" -v e="$t4" -v f="$t5" \
	-v bytes="$DOWN_BYTES" -v upbytes="$UP_BYTES" -v upfail="$UP_FAIL" 'BEGIN {
	dn = b - a; if (dn < 0.05) dn = 0.05
	un = d - c; if (un < 0.05) un = 0.05
	ln = f - e; if (ln < 0) ln = 0
	down = bytes * 8 / 1000 / dn
	up = (upfail == 1) ? 0 : upbytes * 8 / 1000 / un
	printf "DOWN=%d; UP=%d; LAT=%d;\n", down, up, ln * 1000
}')"

printf '{"down_kbps":%s,"up_kbps":%s,"latency_ms":%s,"ts":%s,"server":"speed.cloudflare.com","method":"uclient-fetch"}\n' \
	"$DOWN" "$UP" "$LAT" "$(date +%s)" > "$OUT"

echo "speedtest: down=${DOWN} kbit/s up=${UP} kbit/s latency=${LAT} ms -> $OUT"
