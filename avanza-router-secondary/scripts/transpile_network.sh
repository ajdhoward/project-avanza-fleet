#!/bin/sh
# PROJECT AVANZA / avanza-router-secondary / scripts/transpile_network.sh
# Restricted-YAML -> UCI compiler for the headless switch matrix (busybox ash).
# Modes: --dry-run (default) | --apply | --rollback [stamp|latest]
set -u

VERSION="2.0.0"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SRC_DIR="$REPO_ROOT/configs"
MODE="dry-run"
RB_STAMP=""
BACKUP_ROOT="/overlay/avanza/backup"
BACKUP_KEEP=4
WORK="/tmp/avanza-nettrans.$$"
PREFIX="avanza"

die() { echo "transpile_network: FATAL: $*" >&2; rm -rf "$WORK"; exit 1; }
say() { echo "transpile_network: $*"; }

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run)  MODE="dry-run" ;;
		--apply)    MODE="apply" ;;
		--source)   shift; SRC_DIR="$1" ;;
		--rollback) MODE="rollback"; RB_STAMP="${2:-latest}"; [ $# -gt 1 ] && shift ;;
		-h|--help)  echo "usage: $0 [--dry-run|--apply|--rollback [stamp|latest]] [--source DIR]"; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
	shift
done

[ -f "$SRC_DIR/network.yml" ] || die "missing $SRC_DIR/network.yml"
command -v awk >/dev/null 2>&1 || die "awk required"
mkdir -p "$WORK" || die "cannot create workdir"
trap 'rm -rf "$WORK"' EXIT INT TERM

if grep -q '^  prefix:' "$SRC_DIR/network.yml" 2>/dev/null; then
	PREFIX=$(sed -n 's/^  prefix:[[:space:]]*//p' "$SRC_DIR/network.yml" | head -n1)
fi

cat > "$WORK/parser.awk" <<'AWKEOF'
BEGIN { SQ = sprintf("%c", 39); prefix = "avanza"; sect = ""; initem = 0; subkey = "" }
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function unq(s)  { s = trim(s); if (s ~ /^".*"$/ && length(s) >= 2) s = substr(s, 2, length(s) - 2); return s }
function slug(s) { s = tolower(s); gsub(/[^a-z0-9]+/, "_", s); sub(/^_/, "", s); sub(/_$/, "", s); return s }
function shq(v,  t) { t = v; gsub(SQ, SQ "\\\\" SQ SQ, t); return SQ t SQ }
function flush_item(   id, k, n, arr, i) {
	if (!initem) return
	if (sect == "devices") {
		id = "network.dev_" prefix "_" slug(f["name"])
		printf "set %s=device\n", id
		for (k in f) printf "set %s.%s=%s\n", id, k, shq(f[k])
		n = split(trim(l["ports"]), arr, " ")
		for (i = 1; i <= n; i++) printf "add_list %s.ports=%s\n", id, shq(arr[i])
	} else if (sect == "vlans") {
		id = "network.bv_" prefix "_" slug(f["device"]) "_" f["vlan"]
		printf "set %s=bridge-vlan\n", id
		printf "set %s.device=%s\n", id, shq(f["device"])
		printf "set %s.vlan=%s\n", id, shq(f["vlan"])
		n = split(trim(l["ports"]), arr, " ")
		for (i = 1; i <= n; i++) printf "add_list %s.ports=%s\n", id, shq(arr[i])
	} else if (sect == "interfaces") {
		nm = f["name"]
		if (nm == "") return
		printf "@delete network.%s\n", nm
		id = "network." nm
		printf "set %s=interface\n", id
		for (k in f)
			if (k != "name" && k != "label") {
				if (k == "dns") {
					n = split(f[k], arr, " ")
					for (i = 1; i <= n; i++) printf "add_list %s.dns=%s\n", id, shq(arr[i])
					continue
				}
				printf "set %s.%s=%s\n", id, k, shq(f[k])
			}
	}
	delete f; delete l; initem = 0; subkey = ""
}

/^[ \t]*#/ { next }
/^[ \t]*$/ { next }

/^[A-Za-z_][A-Za-z0-9_]*:[ \t]*$/ {
	flush_item()
	sect = $0
	sub(/:.*$/, "", sect)
	sect = trim(sect)
	initem = 0
	subkey = ""
	next
}

/^  - / {
	flush_item()
	initem = 1
	subkey = ""
	rest = substr($0, 5)
	if (rest ~ /^[A-Za-z0-9_]+:[ \t]+/) {
		k = rest
		sub(/:.*$/, "", k)
		k = trim(k)
		val = rest
		sub(/^[A-Za-z0-9_]+:[ \t]+/, "", val)
		f[k] = unq(val)
	}
	next
}
/^    [A-Za-z0-9_]+:[ \t]*$/ {
	subkey = $0
	sub(/^    /, "", subkey)
	sub(/:.*$/, "", subkey)
	subkey = trim(subkey)
	next
}
/^      - / { l[subkey] = l[subkey] " " unq(substr($0, 9)); next }
/^    [A-Za-z0-9_]+:[ \t]+/ {
	line = $0
	k = line
	sub(/^    /, "", k)
	sub(/:.*$/, "", k)
	k = trim(k)
	val = line
	sub(/^    [A-Za-z0-9_]+:[ \t]+/, "", val)
	f[k] = unq(val)
	next
}

END { flush_item() }
AWKEOF

emit_cleanup() {
	command -v uci >/dev/null 2>&1 || return 0
	uci -q show network 2>/dev/null |
		sed -n "s/^network\.\(\(dev\|bv\|if\)_[A-Za-z0-9_]*_${PREFIX}[A-Za-z0-9_]*\)=.*/delete network.\1/p"
}

transpile() {
	awk -f "$WORK/parser.awk" "$SRC_DIR/network.yml" > "$WORK/raw.out" || die "awk parse failure"
	grep '^@delete ' "$WORK/raw.out" > "$WORK/deletes" 2>/dev/null || : > "$WORK/deletes"
	grep -v '^@delete ' "$WORK/raw.out" > "$WORK/batch" || : > "$WORK/batch"
}

run_deletes() {
	[ -s "$WORK/deletes" ] || return 0
	while read -r _ target; do
		[ -n "$target" ] || continue
		uci -q delete "$target" >/dev/null 2>&1 || true
	done < "$WORK/deletes"
}

prune_backups() {
	keep="$1"
	[ -d "$BACKUP_ROOT" ] || return 0
	total=$(ls -1 "$BACKUP_ROOT" 2>/dev/null | wc -l)
	[ "$total" -gt "$keep" ] || return 0
	ls -1 "$BACKUP_ROOT" | sort | head -n "$((total - keep))" | while read -r s; do rm -rf "$BACKUP_ROOT/$s"; done
}

take_backup() {
	stamp=$(date +%Y%m%d-%H%M%S)
	mkdir -p "$BACKUP_ROOT/$stamp" || die "cannot create backup dir"
	for f in network firewall system dhcp wireless dropbear; do
		[ -f "/etc/config/$f" ] && cp "/etc/config/$f" "$BACKUP_ROOT/$stamp/"
	done
	prune_backups "$BACKUP_KEEP"
	echo "$stamp"
}

case "$MODE" in
	rollback)
		[ "$RB_STAMP" = "latest" ] && RB_STAMP=$(ls -1 "$BACKUP_ROOT" 2>/dev/null | sort | tail -n1)
		[ -n "$RB_STAMP" ] && [ -d "$BACKUP_ROOT/$RB_STAMP" ] || die "snapshot not found: $RB_STAMP"
		say "restoring snapshot $RB_STAMP"
		cp -f "$BACKUP_ROOT/$RB_STAMP/"* /etc/config/ 2>/dev/null
		[ -x /etc/init.d/network ] && /etc/init.d/network restart >/dev/null 2>&1
		[ -x /etc/init.d/firewall ] && /etc/init.d/firewall restart >/dev/null 2>&1
		say "rollback complete"
		;;
	dry-run)
		transpile
		say "=== pre-batch deletes (errors ignored) ==="
		cat "$WORK/deletes"
		say "=== UCI batch (dry-run, prefix=$PREFIX) ==="
		cat "$WORK/batch"
		say "dry-run complete: no changes made. Re-run with --apply."
		;;
	apply)
		command -v uci >/dev/null 2>&1 || die "--apply requires uci (run on the switch node)"
		transpile
		stamp=$(take_backup)
		say "backup snapshot: $BACKUP_ROOT/$stamp"
		run_deletes
		{ emit_cleanup; cat "$WORK/batch"; } > "$WORK/final.batch"
		if ! uci batch "$WORK/final.batch"; then
			say "uci batch FAILED - restoring $stamp"
			cp -f "$BACKUP_ROOT/$stamp/"* /etc/config/ 2>/dev/null
			[ -x /etc/init.d/network ] && /etc/init.d/network restart >/dev/null 2>&1
			die "aborted, previous config restored"
		fi
		uci commit network
		[ -x /etc/init.d/network ] && /etc/init.d/network restart >/dev/null 2>&1
		sleep 3
		if ip addr show br-switch.40 >/dev/null 2>&1 || ip addr show br-switch >/dev/null 2>&1; then
			say "apply complete (snapshot $stamp retained): br-switch present"
		else
			say "VERIFY FAIL: br-switch missing after restart - rollback with: $0 --rollback $stamp"
			exit 2
		fi
		;;
esac
exit 0
