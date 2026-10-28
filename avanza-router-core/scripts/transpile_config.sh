#!/bin/sh
# PROJECT AVANZA / avanza-router-core / scripts/transpile_config.sh
# Dependency-free restricted-YAML -> OpenWrt UCI compiler (busybox ash).
# Modes: --dry-run (default) | --apply | --rollback [stamp|latest]
set -u

VERSION="1.0.0"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SRC_DIR="$REPO_ROOT/configs"
MODE="dry-run"
RB_STAMP=""
BACKUP_ROOT="/overlay/avanza/backup"
BACKUP_KEEP=6
WORK="/tmp/avanza-transpile.$$"
PREFIX="avanza"

die() { echo "transpile_config: FATAL: $*" >&2; rm -rf "$WORK"; exit 1; }
say() { echo "transpile_config: $*"; }

usage() {
	cat <<EOF
transpile_config.sh v$VERSION - Avanza YAML->UCI compiler (OpenWrt 25.12 / apk / fw4)
usage: $0 [--dry-run|--apply] [--source DIR] [--rollback [stamp|latest]]
  --dry-run   print the generated UCI batch + include copies (default)
  --apply     backup live config, transpile, commit, reload services
  --rollback  restore a snapshot from $BACKUP_ROOT (default: latest)
EOF
	exit 0
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run)  MODE="dry-run" ;;
		--apply)    MODE="apply" ;;
		--source)   shift; SRC_DIR="$1" ;;
		--rollback) MODE="rollback"; RB_STAMP="${2:-latest}"; [ $# -gt 1 ] && shift ;;
		-h|--help)  usage ;;
		*) die "unknown argument: $1" ;;
	esac
	shift
done

for t in awk sed sort grep cut date mkdir cp; do
	command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
done

[ -d "$SRC_DIR" ] || die "config dir not found: $SRC_DIR"
for f in firewall.yml sqm.yml umdns.yml; do
	[ -f "$SRC_DIR/$f" ] || die "missing config: $SRC_DIR/$f"
done

mkdir -p "$WORK" || die "cannot create workdir"
trap 'rm -rf "$WORK"' EXIT INT TERM

if grep -q '^  prefix:' "$SRC_DIR/firewall.yml" 2>/dev/null; then
	PREFIX=$(sed -n 's/^  prefix:[[:space:]]*//p' "$SRC_DIR/firewall.yml" | head -n1)
fi
[ -n "$PREFIX" ] || PREFIX="avanza"

cat > "$WORK/parser.awk" <<'AWKEOF'
BEGIN {
	SQ = sprintf("%c", 39)
	prefix = "avanza"
	sect = ""
	initem = 0
	subkey = ""
	flatmode = 0
}
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function unq(s)  { s = trim(s); if (s ~ /^".*"$/ && length(s) >= 2) s = substr(s, 2, length(s) - 2); return s }
function slug(s) { s = tolower(s); gsub(/[^a-z0-9]+/, "_", s); sub(/^_/, "", s); sub(/_$/, "", s); return s }
function shq(v,  t) { t = v; gsub(SQ, SQ "\\\\" SQ SQ, t); return SQ t SQ }
function flush_item(   id, k, n, arr, i, rn) {
	if (!initem) return
	if (sect == "zones") {
		id = "firewall.zone_" prefix "_" f["name"]
		printf "set %s=firewall.zone\n", id
		printf "set %s.name=%s\n", id, shq(f["name"])
		for (k in f)
			if (k != "name" && k != "label")
				printf "set %s.%s=%s\n", id, k, shq(f[k])
		n = split(trim(l["networks"]), arr, " ")
		for (i = 1; i <= n; i++)
			printf "add_list %s.network=%s\n", id, shq(arr[i])
	} else if (sect == "forwards") {
		id = "firewall.fwd_" prefix "_" f["src"] "_" f["dest"]
		printf "set %s=firewall.forwarding\n", id
		printf "set %s.src=%s\n", id, shq(f["src"])
		printf "set %s.dest=%s\n", id, shq(f["dest"])
	} else if (sect == "rules" || sect == "redirects") {
		rn = slug(f["name"])
		sub("^" prefix "_", "", rn)
		if (sect == "rules") {
			id = "firewall.rule_" prefix "_" rn
			printf "set %s=firewall.rule\n", id
		} else {
			id = "firewall.redir_" prefix "_" rn
			printf "set %s=firewall.redirect\n", id
		}
		for (k in f) {
			if (k == "proto" || k == "dest_port" || k == "src_port" || k == "src_dport") {
				n = split(f[k], arr, " ")
				if (n > 1) {
					for (i = 1; i <= n; i++)
						printf "add_list %s.%s=%s\n", id, k, shq(arr[i])
					continue
				}
			}
			printf "set %s.%s=%s\n", id, k, shq(f[k])
		}
	} else if (sect == "nftables_includes") {
		printf "@copy %s %s\n", f["source"], f["path"]
	}
	delete f
	delete l
	initem = 0
	subkey = ""
}
function flush_flat(   id, k, n, arr, i) {
	if (sect == "queue" && FL["interface"] != "") {
		id = "sqm.queue_" prefix "_" FL["interface"]
		printf "set %s=queue\n", id
		for (k in FL)
			if (k != "networks")
				printf "set %s.%s=%s\n", id, k, shq(FL[k])
	} else if (sect == "umdns") {
		id = "umdns.umdns_" prefix
		printf "set %s=umdns\n", id
		for (k in FL)
			if (k != "networks")
				printf "set %s.%s=%s\n", id, k, shq(FL[k])
		n = split(trim(flatlist["networks"]), arr, " ")
		for (i = 1; i <= n; i++)
			printf "add_list %s.network=%s\n", id, shq(arr[i])
	}
	delete FL
	delete flatlist
}

/^[ \t]*#/ { next }
/^[ \t]*$/ { next }

/^[A-Za-z_][A-Za-z0-9_]*:[ \t]*$/ {
	flush_item()
	flush_flat()
	sect = $0
	sub(/:.*$/, "", sect)
	sect = trim(sect)
	initem = 0
	subkey = ""
	flatmode = (sect == "meta" || sect == "queue" || sect == "umdns")
	next
}

flatmode {
	if ($0 ~ /^  [A-Za-z0-9_]+:[ \t]*$/) {
		subkey = $0
		sub(/^  /, "", subkey)
		sub(/:.*$/, "", subkey)
		subkey = trim(subkey)
		next
	}
	if ($0 ~ /^    - /) {
		flatlist[subkey] = flatlist[subkey] " " unq(substr($0, 7))
		next
	}
	if ($0 ~ /^  [A-Za-z0-9_]+:[ \t]+/) {
		line = $0
		k = line
		sub(/^  /, "", k)
		sub(/:.*$/, "", k)
		k = trim(k)
		val = line
		sub(/^  [A-Za-z0-9_]+:[ \t]+/, "", val)
		val = unq(val)
		FL[k] = val
		if (sect == "meta" && k == "prefix") prefix = val
		next
	}
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
		val = unq(val)
		f[k] = val
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
/^      - / {
	l[subkey] = l[subkey] " " unq(substr($0, 9))
	next
}
/^    [A-Za-z0-9_]+:[ \t]+/ {
	line = $0
	k = line
	sub(/^    /, "", k)
	sub(/:.*$/, "", k)
	k = trim(k)
	val = line
	sub(/^    [A-Za-z0-9_]+:[ \t]+/, "", val)
	val = unq(val)
	f[k] = val
	next
}

END { flush_item(); flush_flat() }
AWKEOF

emit_cleanup() {
	command -v uci >/dev/null 2>&1 || return 0
	for pkg in firewall sqm umdns; do
		uci -q show "$pkg" 2>/dev/null |
			sed -n "s/^${pkg}\.\([A-Za-z0-9_]*_${PREFIX}[A-Za-z0-9_]*\)=.*/delete ${pkg}.\1/p"
	done
}

transpile_all() {
	: > "$WORK/raw.out"
	for y in firewall sqm umdns; do
		awk -f "$WORK/parser.awk" "$SRC_DIR/$y.yml" >> "$WORK/raw.out" ||
			die "awk parse failure in $y.yml"
	done
	grep -v '^@copy' "$WORK/raw.out" > "$WORK/batch" || : > "$WORK/batch"
	grep '^@copy' "$WORK/raw.out" > "$WORK/copies" 2>/dev/null || : > "$WORK/copies"
}

prune_backups() {
	keep="$1"
	[ -d "$BACKUP_ROOT" ] || return 0
	total=$(ls -1 "$BACKUP_ROOT" 2>/dev/null | wc -l)
	[ "$total" -gt "$keep" ] || return 0
	ls -1 "$BACKUP_ROOT" | sort | head -n "$((total - keep))" | while read -r s; do
		rm -rf "$BACKUP_ROOT/$s"
	done
}

take_backup() {
	command -v uci >/dev/null 2>&1 || return 0
	stamp=$(date +%Y%m%d-%H%M%S)
	mkdir -p "$BACKUP_ROOT/$stamp" || die "cannot create backup dir"
	for f in firewall sqm umdns network wireless dhcp; do
		[ -f "/etc/config/$f" ] && cp "/etc/config/$f" "$BACKUP_ROOT/$stamp/"
	done
	prune_backups "$BACKUP_KEEP"
	echo "$stamp"
}

reload_services() {
	[ -x /etc/init.d/firewall ] && /etc/init.d/firewall restart >/dev/null 2>&1
	[ -x /etc/init.d/sqm ] && /etc/init.d/sqm restart >/dev/null 2>&1
	[ -x /etc/init.d/umdns ] && /etc/init.d/umdns restart >/dev/null 2>&1
}

do_rollback() {
	stamp="$1"
	if [ "$stamp" = "latest" ]; then
		stamp=$(ls -1 "$BACKUP_ROOT" 2>/dev/null | sort | tail -n1)
	fi
	[ -n "$stamp" ] && [ -d "$BACKUP_ROOT/$stamp" ] || die "rollback snapshot not found: $stamp"
	say "restoring snapshot $stamp"
	cp -f "$BACKUP_ROOT/$stamp/"* /etc/config/ 2>/dev/null
	reload_services
	say "rollback complete; fw4 ruleset re-verified:"
	fw4 -q print >/dev/null 2>&1 && say "  fw4 print: OK" || say "  fw4 print: WARN (inspect manually)"
}

verify() {
	warn=0
	if command -v fw4 >/dev/null 2>&1; then
		fw4 -q print >/dev/null 2>&1 || { say "VERIFY FAIL: fw4 could not render the new ruleset"; warn=1; }
	fi
	if command -v nft >/dev/null 2>&1; then
		nft list table inet fw4 2>/dev/null | grep -q avanza_lane_priority ||
			{ say "VERIFY WARN: avanza lane sets absent from live table (firewall reload pending?)"; warn=1; }
	fi
	[ $warn -eq 0 ] && say "verify: OK"
	return $warn
}

case "$MODE" in
	rollback)
		do_rollback "$RB_STAMP"
		;;
	dry-run)
		transpile_all
		say "=== UCI batch (dry-run, prefix=$PREFIX) ==="
		cat "$WORK/batch"
		if [ -s "$WORK/copies" ]; then
			say "=== nftables include copies ==="
			while read -r _ src dst; do
				say "install -m 0644 $REPO_ROOT/$src $dst"
			done < "$WORK/copies"
		fi
		say "dry-run complete: no changes made. Re-run with --apply."
		;;
	apply)
		command -v uci >/dev/null 2>&1 || die "--apply requires uci (run on the router)"
		transpile_all
		stamp=$(take_backup)
		say "backup snapshot: $BACKUP_ROOT/$stamp"
		{ emit_cleanup; cat "$WORK/batch"; } > "$WORK/final.batch"
		if ! uci batch "$WORK/final.batch"; then
			say "uci batch FAILED - restoring snapshot $stamp"
			cp -f "$BACKUP_ROOT/$stamp/"* /etc/config/ 2>/dev/null
			reload_services
			die "transpile aborted, previous config restored"
		fi
		while read -r _ src dst; do
			[ -n "$src" ] && [ -n "$dst" ] || continue
			[ -f "$REPO_ROOT/$src" ] || die "include source missing: $REPO_ROOT/$src"
			mkdir -p "$(dirname "$dst")"
			cp "$REPO_ROOT/$src" "$dst" || die "cannot install $dst"
			chmod 0644 "$dst"
			say "installed $dst"
		done < "$WORK/copies"
		uci commit firewall
		uci commit sqm
		uci commit umdns
		reload_services
		if ! verify; then
			say "verification reported problems - rollback with: $0 --rollback $stamp"
		else
			say "apply complete (snapshot $stamp retained for rollback)"
		fi
		;;
esac

exit 0
