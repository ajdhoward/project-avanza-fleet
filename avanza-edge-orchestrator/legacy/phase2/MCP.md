# MCP endpoint — `src/mcp_server.ts` (mounted at `/mcp` on the fleet Worker)

Model Context Protocol surface of the unified orchestrator Worker — gives any
MCP-capable LLM client (Claude Desktop, Cursor, `mcp-remote`, custom agents)
**direct, authenticated, autonomous management of the Avanza fleet**.

Zero dependencies: hand-rolled JSON-RPC 2.0 with POST-only Streamable-HTTP
semantics (`initialize`, `notifications/initialized`, `ping`, `tools/list`,
`tools/call`, spec error codes). MCP protocol version `2025-03-26`.
Deployed as part of the single `wrangler deploy` — no second script, no
cross-script binding: `traffic_classifier.ts` routes `/mcp` into `handleMcp()`
and the tools read the same in-script `AvanzaState` Durable Object the agents
feed.

## Tools

| Tool | Effect |
|---|---|
| `get_fleet_status()` | DO snapshots of BOTH nodes (primary C7 v5 + secondary W8968 v3): online flag, OpenWrt version, RAM/overlay/conntrack, WAN-down count, GitOps convergence state, plus outage-oracle verdict, firmware status, last speedtest |
| `get_powerline_topology()` | parsed `plcstat` ring (48 samples) from the primary: Tx/Rx PHY Mbps, attenuation dB, derived A–D grade + remediation advice, trunk description |
| `set_device_override_lane(ip, lane, duration_secs)` | validates (`192.168.*` only, lane enum, 60–86400 s) → DO override → agent applies `nft add element inet fw4 avanza_lane_* { ip timeout Ns }` ≤60 s later; response includes the exact router command |
| `evaluate_guest_unblock_requests(approve?, deny?)` | reads Turnstile-protected `/guest` requests from KV; approvals queue `resume` actions to the agent; returns pending/approved/denied/remaining |

## Auth

`X-Avanza-Signature: t=<unix>,v1=<hex>` where
`v1 = HMAC-SHA256(MCP_HMAC_KEY, "<t>.<raw-body>")`, 300 s replay window,
timing-safe compare; `X-Avanza-Token: <key>` accepted as fallback. Use a
**dedicated** `MCP_HMAC_KEY` (not the agent key) so LLM-side compromise cannot
forge router telemetry.

## Deploy

Ships with the fleet Worker:

```sh
wrangler secret put MCP_HMAC_KEY --config ../avanza-infra-iac/wrangler.toml --env primary
wrangler deploy --config ../avanza-infra-iac/wrangler.toml --env primary
```

Use a **dedicated** `MCP_HMAC_KEY` (falls back to `AGENT_HMAC_KEY` when unset,
but rotating them independently means an LLM-side leak cannot forge router
telemetry).

## Client wiring (Claude Desktop example)

```json
{
  "mcpServers": {
    "avanza": {
      "command": "npx",
      "args": ["mcp-remote", "https://avanza-fleet-primary.<subdomain>.workers.dev/mcp",
               "--header", "X-Avanza-Token:${AVANZA_MCP_KEY}"]
    }
  }
}
```

## Guardrails

- Read tools never mutate; the only mutating tool (`set_device_override_lane`)
  is TTL-bounded (≤24 h), IP-range-restricted, and lands in the same manual-
  override class the app uses — the CAKE host-fairness floor still protects
  every other device.
- Guest approvals only ever *resume* (never pause) — an LLM cannot cut the
  network via this tool surface; pausing stays human-only (app/extension).
- All $5-plan compliant: sporadic tool calls ride the included 10 M
  requests/month; no Queues/Containers/enterprise surface.
