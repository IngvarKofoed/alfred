# Embedded browser bridge (build-order step 5)

Give Alfred a real browser. A Chrome extension (ported from the owner's `~/private/chrome-mcp`)
drives the owner's real Chrome over a WebSocket; the WebSocket *server* is embedded directly in
the `alfred-worker` process (no separate process, no MCP), and each browser command is exposed as a
built-in agent-core `Tool` wired into the existing run loop. To start, *every* browser command is
`write` tier, so each action pauses for owner approval through the gate that already exists
(changelog 19) — a deliberately conservative first cut we can relax later.

This is **Option C** from the design conversation: the simplest expression of "no MCP in the
codebase," at the cost of coupling the extension's connection to worker uptime (acceptable — the
extension already auto-reconnects, and we fail-and-restart runs anyway, §7.6).

## Key decisions

- **Bridge embedded in the worker, not a separate process** (diverges). ARCHITECTURE §8 specifies a
  standalone `alfred-browser-bridge` process exposing MCP over HTTP+SSE. We instead run the WebSocket
  server *inside* `alfred-worker`. Reason: with one user, the only thing the process split bought was
  surviving worker restarts — and the extension already reconnects with backoff on its own. Embedding
  removes a process, a port pair, and the entire MCP client/server layer.
- **Browser actions are built-in `Tool`s, zero MCP** (reuses). Each command becomes a `Tool`
  (`tool.ts:4-10`) whose `invoke()` calls `bridge.sendCommand(...)` in-process — exactly the built-in
  path §7.3 already sanctions, the same shape as `echoTool`. The `@modelcontextprotocol/sdk` server
  layer in chrome-mcp is dropped entirely.
- **Multi-tab model kept** (diverges). chrome-mcp's `list_tabs`/`switch_tab`/`open_tab`/`close_tab`
  come over as-is, rather than §8's single-active-tab MVP simplification. No reason to throw away
  working richness.
- **Loopback bind + a one-line Origin guard replace `BRIDGE_AUTH_TOKEN`** (diverges). §13.1's shared
  token is dropped, and so is the per-extension-ID machinery (no `.env` ID, no pinned manifest key).
  Two cheap guards instead: (1) bind the WS server to `127.0.0.1` so other devices can't reach it
  (`ws` binds to all interfaces by default — we pin `host`); (2) reject any WS upgrade whose `Origin`
  doesn't start with `chrome-extension://`. The lifted `WebSocketBridge` currently accepts *any*
  connection and even replaces the live extension (`websocket-bridge.ts:31-36`), so a webpage you visit
  could open `ws://127.0.0.1:<port>` (loopback is its loopback too) and impersonate the extension —
  feeding the agent forged page content or lying about action results. A webpage can't forge a
  `chrome-extension://` origin, so the guard closes that local drive-by with no config. (Blocking
  *other extensions* would need the per-ID check; not worth it on a single-user machine.)
- **Trust-tier gating: every browser tool is `write` to start** (extends). All browser commands —
  including reads and `evaluate_javascript` — declare `trustTier: 'write'`, so each one pauses for
  approval. This reuses the changelog-19 machinery untouched; only the per-tool tier assignment is new.
  Deliberately conservative for the first cut (accepts approval fatigue in exchange for "nothing the
  browser does happens without a click"); a read/write split to cut fatigue is an easy later refinement
  once we trust the flow. `evaluate_javascript` is a candidate to bump to `destructive` later.
- **Extension lives at `chrome-extension/`** (reuses). Ported into the repo as the workspace member
  §14.3 already reserves, sharing the `WebSocketRequest`/`WebSocketResponse` protocol types with the
  worker's bridge module. Built with its own esbuild story, outside the services/clients split.
- **No worker-side browser mutex in MVP** (diverges). §7.6 mandates an in-process mutex serializing
  the single Chrome across runs. We omit it for now: with every mutating action approval-gated, the
  human already serializes browser use, and two simultaneous browser-using conversations is not a
  real single-user scenario. Documented as a known limitation, not designed around.

## Goals

- Alfred can navigate, read, and act on pages in the owner's real Chrome, end to end, through the
  existing chat → worker → approval → SSE pipeline.
- Mutating browser actions pause for owner approval using the machinery already built; reading does not.
- A webpage you visit cannot impersonate the extension (a webpage can't forge a `chrome-extension://`
  origin). Note: a *non-browser* local process could still spoof the Origin header — out of scope on a
  single-user machine, where arbitrary local processes are already trusted.
- The extension survives worker restarts by reconnecting on its own.

## Non-goals

- **§16 structural browser containment** — separate untrusted/trusted Chrome profiles, sensitive-domain
  gating, and task-scoped approval (approve an objective, not each click). This is the real long-term
  safety story; MVP relies on per-action approval as the stopgap. Explicitly deferred.
- **MCP of any kind** — no client, no server, no generic multi-server integration. That arrives only
  when we want third-party MCP servers (Gmail, etc.).
- **Discord/voice surfacing of browser approvals** — uses whatever the current interaction surfacing
  already supports (web). No new ingress work.
- **Multimodal / vision (the agent *seeing* images)** — agent-core has no image content part and the
  Gemini provider no `inlineData` path (`types.ts:7-11`). Whether screenshots ship here hinges on this;
  see Open Questions. The vision plumbing itself is out of scope for the embedded-bridge work regardless.

## Design

### Topology

```
Chrome (owner profile) ─ Alfred extension (MV3)
        │  ws://127.0.0.1:<BRIDGE_WS_PORT>   (Origin-checked)
        ▼
alfred-worker process
  ├─ BrowserBridge (WebSocket server, singleton, started at boot)
  └─ runJob → runAgent(tools: [echo, set_title, ...browserTools])
                              │ invoke() → bridge.sendCommand(cmd, params)
                              ▼ existing approval gate for write/destructive
```

### The bridge module (`services/worker/src/browser/`)

Lift `websocket-bridge.ts` (~130 lines) and `types.ts` from chrome-mcp essentially verbatim, with two
changes:

1. **Loopback bind + Origin guard.** Construct the `WebSocketServer` with `host: '127.0.0.1'` (off the
   network) and a `verifyClient` that accepts a connection only if `req.headers.origin?.startsWith(
   "chrome-extension://")`. No specific ID to match, no config — a webpage can't present a
   `chrome-extension://` origin, which is the whole point.
2. **Singleton lifecycle.** A module-level `BrowserBridge` is `start()`ed once in
   `services/worker/src/index.ts` at boot (next to the orphan sweep) and `stop()`ed on
   SIGINT/SIGTERM. `bridge.isConnected` / `sendCommand` are imported by the tool factory.

`sendCommand(command, params)` keeps its id-keyed `pendingRequests` map and 30s timeout. When no
extension is connected it throws `"Chrome extension is not connected"` — which the agent loop already
turns into a tool error the model can read and react to (§10.7).

### Tool factory (`services/worker/src/browser/tools.ts`)

A `makeBrowserTools(): Tool[]` returns one `Tool` per command. Each `invoke(args)` calls
`bridge.sendCommand(name, args)` and returns the result. JSON-schema `inputSchema` is hand-written per
tool (the args are simple: `url`, `selector`, `text`, `direction`, `tabId`, …), replacing chrome-mcp's
zod schemas. `run.ts:83` changes from `[echoTool, makeSetTitleTool(...)]` to additionally spread
`...makeBrowserTools()`.

### Gating

Every browser command is `trustTier: 'write'`, so all of them pause for approval. The commands ported
from chrome-mcp:

- **Reads:** `get_page_text`, `get_page_html`, `get_page_title`, `get_links`, `get_headings`,
  `get_current_url`, `get_form_fields`, `query_selector`, `list_tabs`
- **Mutations / navigation:** `navigate`, `go_back`, `go_forward`, `reload`, `click`, `type_text`,
  `select_option`, `scroll`, `hover`, `open_tab`, `close_tab`, `switch_tab`
- **Arbitrary JS:** `evaluate_javascript`

Uniform `write` is the conservative starting point — every browser action gets a click, full stop. The
cost is approval fatigue (a real task is many round-trips); the benefit is zero browser side effects
without explicit consent while we build trust in the flow. A later refinement can demote the pure-reads
to `read` and/or promote `evaluate_javascript` to `destructive`; both are one-line tier changes.

### Extension (`chrome-extension/`)

Port `background.ts`, `content.ts`, `types.ts`, `manifest.json`, icons, and the esbuild `build.js` from
chrome-mcp's `chrome-extension/`. Changes:

- `WS_URL` points at `ws://127.0.0.1:<port>` matching `BRIDGE_WS_PORT` (default 7865, same as today).
- Rename branding (`chrome-mcp` → Alfred) cosmetically. Reconnect/keepalive logic is unchanged.

No manifest `"key"` pinning is needed — the bridge's Origin guard checks only the `chrome-extension://`
*scheme*, not a specific extension ID, so the (path-derived) ID can be whatever Chrome assigns.

### Config additions (`packages/shared/src/config.ts`)

```
BRIDGE_WS_PORT   number, default 7865
```

Just the one port. No token, no extension ID — the loopback bind + `chrome-extension://` Origin guard
need no configuration.

Both optional so non-worker processes still boot. `.env.example` documents them; `BRIDGE_AUTH_TOKEN`
is removed.

### Doc updates (part of this increment)

- **§8** — replace the separate-process/MCP-over-HTTP topology with the embedded-bridge + built-in-tools
  shape; note multi-tab; replace the auth-token line with the loopback bind + `chrome-extension://`
  Origin guard.
- **§13.1 / `.env.example`** — drop `BRIDGE_AUTH_TOKEN` and `BRIDGE_MCP_PORT`; keep `BRIDGE_WS_PORT`.
- **§7.6** — note the browser mutex is not implemented in MVP and why (approval serializes in practice).
- **§5 / process topology** — `alfred-browser-bridge` is folded into `alfred-worker`, not its own pm2 process.
- **§15** — mark step 5 as built; note Option C divergence from the original §8 design.
- **§16** — reaffirm that per-action approval here is the stopgap and structural containment is still
  the deferred real answer.

## Open questions

- **Q: Screenshots — ship them in this increment, or split into a follow-up "vision" increment?**
  You asked to include them, but they're not free: a screenshot returns a base64 image, and for the
  agent to actually *see* it we need a new image content part in agent-core (`types.ts`), an
  `inlineData` path in `GeminiProvider`, and a decision on where the bytes live (§6.5 says large
  attachments go to the filesystem, not inline in `messages.content` jsonb). That's a multimodal change
  touching the agent-core core that nothing else here touches.
  **Default:** split it out — land the embedded bridge text-only now (the 22 non-screenshot tools), and
  do screenshots + vision as the immediately-following increment, so this one stays clean and the image
  path gets the attention it needs. The alternative is to grow
  this spec to include the image-content path and the attachment-storage decision.

## Alternatives considered

- **Approach A — separate bridge process (chrome-mcp verbatim) + ~50-line MCP client in the worker.**
  Matches §8 exactly, reuses chrome-mcp with zero edits, survives restarts cleanly. Rejected for MVP:
  introduces MCP into the codebase before it earns its keep, and the restart-survival it buys is
  redundant with the extension's own reconnect for a single user.
- **Approach B — separate process, plain HTTP/JSON instead of MCP + built-in tools.** Avoids MCP but
  requires *rewriting* chrome-mcp's front door and inventing a worker↔bridge protocol — strictly more
  work than either A or C. Rejected as worst-of-both.
