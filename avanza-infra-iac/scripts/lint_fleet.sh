#!/bin/sh
# PROJECT AVANZA / avanza-infra-iac / scripts/lint_fleet.sh
# CI dry-run linter for the whole fleet repo: shell syntax, both YAML->UCI
# transpilers, YAML/JSON parse, extension JS, artifact JS extraction.
# Exit non-zero on any failure. Runs on busybox, dash, bash and GH ubuntu.
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
FAIL=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; FAIL=1; }
skip(){ echo "SKIP  $1"; }

cd "$ROOT" || { echo "repo root not found"; exit 1; }

echo "== 1. shell syntax (sh -n) =="
for f in \
	avanza-router-core/scripts/transpile_config.sh \
	avanza-router-core/scripts/speedtest.sh \
	avanza-router-core/router/lightweight_agent.sh \
	avanza-router-core/router/lightweight_agent_v2.sh \
	avanza-router-core/router/avanza.init \
	avanza-router-secondary/scripts/strip_secondary.sh \
	avanza-router-secondary/scripts/transpile_network.sh \
	avanza-router-secondary/scripts/secondary_agent.sh \
	avanza-router-secondary/scripts/avanza-switch.init \
	avanza-companion-linux/avanza-companion.sh \
	avanza-companion-linux/install.sh
do
	[ -f "$f" ] || { bad "missing $f"; continue; }
	if sh -n "$f" 2>/dev/null; then ok "$f"; else bad "$f"; fi
done
if command -v bash >/dev/null 2>&1 && [ -f avanza-edge-orchestrator/scripts/setup_account.sh ]; then
	bash -n avanza-edge-orchestrator/scripts/setup_account.sh && ok "setup_account.sh (bash -n)" || bad "setup_account.sh"
fi

echo "== 2. primary transpiler dry-run =="
if (cd avanza-router-core && sh scripts/transpile_config.sh --dry-run > /tmp/lint_primary.uci 2>/dev/null); then
	ok "transpile_config.sh --dry-run"
else
	bad "transpile_config.sh --dry-run"
fi
for token in zone_avanza_lan zone_avanza_media zone_avanza_iot zone_avanza_guest zone_avanza_fleet \
	fwd_avanza_fleet_wan rule_avanza_mdns_media_to_mgmt redir_avanza_dns_hijack_guest \
	sqm.queue_avanza_wan umdns.umdns_avanza "10-avanza-lanes.nft"
do
	if grep -q "$token" /tmp/lint_primary.uci 2>/dev/null; then ok "uci token: $token"; else bad "uci token missing: $token"; fi
done
for nfttoken in "set avanza_lane_priority" "set avanza_lane_video" "set avanza_lane_bulk" \
	"counter avanza_lateral_blocked" "ip dscp set 0x2e" "chain mangle_postrouting" "chain mangle_prerouting"
do
	if grep -q "$nfttoken" avanza-router-core/nft/10-avanza-lanes.nft 2>/dev/null; then ok "nft include: $nfttoken"; else bad "nft include missing: $nfttoken"; fi
done

echo "== 3. secondary transpiler dry-run =="
if (cd avanza-router-secondary && sh scripts/transpile_network.sh --dry-run > /tmp/lint_secondary.uci 2>/dev/null); then
	ok "transpile_network.sh --dry-run"
else
	bad "transpile_network.sh --dry-run"
fi
for token in dev_avanza_br_switch bv_avanza_br_switch_20 bv_avanza_br_switch_40 "set network.fleet=interface" "set network.switchmedia=interface" \
	"vlan_filtering='1'" "ports='lan1:t'" "ports='lan1\\*'"
do
	if grep -q -- "$token" /tmp/lint_secondary.uci 2>/dev/null; then ok "uci token: $token"; else bad "uci token missing: $token"; fi
done

echo "== 4. YAML parse =="
if python3 -c "import yaml" >/dev/null 2>&1; then
	for y in avanza-router-core/configs/*.yml avanza-router-secondary/configs/*.yml; do
		if python3 -c "import yaml,sys; yaml.safe_load(open('$y'))" 2>/dev/null; then ok "yaml: $y"; else bad "yaml: $y"; fi
	done
else
	skip "pyyaml unavailable (transpiler dry-runs above already prove structure)"
fi

echo "== 5. JSON parse =="
if command -v node >/dev/null 2>&1; then
	for j in avanza-app-expo/expo-app/package.json avanza-app-expo/expo-app/app.json \
		avanza-app-expo/expo-app/tsconfig.json avanza-edge-orchestrator/package.json \
		avanza-edge-orchestrator/tsconfig.json avanza-generative-ui/package.json \
		avanza-browser-extension/manifest.json
	do
		if node -e "JSON.parse(require('fs').readFileSync('$j','utf8'))" 2>/dev/null; then ok "json: $j"; else bad "json: $j"; fi
	done
	for js in avanza-browser-extension/background.js avanza-browser-extension/popup.js avanza-browser-extension/options.js; do
		if node --check "$js" 2>/dev/null; then ok "node --check: $js"; else bad "node --check: $js"; fi
	done
	if node -e "
const fs=require('fs');
const html=fs.readFileSync('avanza-generative-ui/artifacts/avanza-topology-matrix.html','utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>/);
if(!m) process.exit(1);
fs.writeFileSync('/tmp/lint_artifact.js',m[1]);
" 2>/dev/null && node --check /tmp/lint_artifact.js 2>/dev/null; then
		ok "artifact inline JS"
	else
		bad "artifact inline JS"
	fi
else
	skip "node unavailable"
fi

echo "== 6. TypeScript parse (esbuild, no install) =="
if command -v npx >/dev/null 2>&1 && [ "${LINT_TS:-1}" = "1" ]; then
	TS_FILES="avanza-edge-orchestrator/src/types.ts avanza-edge-orchestrator/src/state_do.ts avanza-edge-orchestrator/src/traffic_classifier.ts avanza-edge-orchestrator/src/outage_oracle.ts avanza-edge-orchestrator/src/weekly_report.ts avanza-edge-orchestrator/src/mcp_server.ts avanza-app-expo/expo-app/app/index.tsx avanza-app-expo/expo-app/app/tv.tsx avanza-app-expo/expo-app/app/_layout.tsx avanza-app-expo/expo-app/src/lib/api.ts avanza-app-expo/expo-app/src/sdui/library.tsx avanza-app-expo/expo-app/src/sdui/useOpenUIStream.ts avanza-generative-ui/src/TopologyCanvas.tsx"
	tsfail=0
	for t in $TS_FILES; do
		npx --yes esbuild "$t" --loader:.ts=ts --loader:.tsx=tsx --outfile=/dev/null >/dev/null 2>&1 || { bad "esbuild parse: $t"; tsfail=1; }
	done
	[ "$tsfail" -eq 0 ] && ok "esbuild parse: all $(echo "$TS_FILES" | wc -w | tr -d ' ') TS/TSX files"
else
	skip "npx/LINT_TS disabled"
fi

echo "== 7. workflow sanity =="
if [ -f .github/workflows/deploy-fleet.yml ]; then
	ok "deploy-fleet.yml present"
	grep -q "r2 object put" .github/workflows/deploy-fleet.yml && ok "workflow uploads bundles to R2" || bad "workflow missing R2 upload"
	grep -q "fleet:config:version" .github/workflows/deploy-fleet.yml && ok "workflow bumps KV version token" || bad "workflow missing KV version bump"
	grep -q -- "--env primary" .github/workflows/deploy-fleet.yml && ok "workflow deploys primary env" || bad "workflow missing primary deploy"
else
	bad ".github/workflows/deploy-fleet.yml missing"
fi

echo
if [ "$FAIL" -eq 0 ]; then
	echo "LINT FLEET: ALL PASS"
	exit 0
fi
echo "LINT FLEET: FAILURES PRESENT"
exit 1
