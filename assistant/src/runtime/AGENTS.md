# Runtime — Agent Instructions

## HTTP API Patterns

### Sending messages

The single HTTP send endpoint is `POST /v1/messages`. Key behaviors:

- **Queue if busy**: When the conversation is processing, messages are queued and processed when the current agent turn completes. No 409 rejections.
- **Fire-and-forget**: Returns `202 { accepted: true }` immediately. The client observes progress via SSE (`GET /v1/events`).
- **Hub publishing**: All agent events are published to `assistantEventHub`, making them observable via SSE.

Do NOT add new send endpoints. All message ingress should go through `POST /v1/messages` (HTTP).

### GET handler idempotency

GET handlers must be safe and side-effect-free — they must not enqueue background jobs, mutate database state, or trigger writes. If a feature needs server-initiated work in response to a client request, use an explicit POST endpoint or a push-based flow (SSE event → client refetch). See [RFC 9110 §9.2.1 — Safe Methods](https://httpwg.org/specs/rfc9110.html#safe.methods).

### Approvals (confirmations, secrets, trust rules)

Approvals are **orthogonal to message sending**. The assistant asks for approval whenever it needs one — this is a separate concern from how a message enters the system.

- **Discovery**: Clients discover pending approvals via SSE events (`confirmation_request`, `secret_request`) which include a `requestId`.
- **Resolution**: Clients respond via standalone endpoints keyed by `requestId`:
  - `POST /v1/confirm` — `{ requestId, decision, selectedPattern?, selectedScope? }`. Valid decisions: `"allow"`, `"allow_10m"`, `"allow_conversation"`, `"deny"`, `"always_allow"`, `"always_deny"`. For persistent decisions (`always_allow`, `always_deny`), `selectedPattern` and `selectedScope` are validated against the server-provided allowlist/scope options from the original confirmation request before trust rules are persisted.
  - `POST /v1/secret` — `{ requestId, value, delivery }`
  - `POST /v1/trust-rules` — `{ requestId, pattern, scope, decision }`. Validates pattern/scope against server-provided options. Does not resolve the confirmation itself.
- **Tracking**: The `pending-interactions` tracker (`assistant/src/runtime/pending-interactions.ts`) maps `requestId → conversation`. Use `register()` to track, `resolve()` to consume, `getByConversation()` to query.

Do NOT couple approval handling to message sending. Do NOT add run/status tracking to the send path.

### Host bash (desktop proxy execution)

Host bash allows the assistant to execute shell commands on the desktop host machine via the client, rather than in the daemon's own sandbox.

- **Discovery**: Clients discover pending host bash requests via SSE events (`host_bash_request`) which include a `requestId`.
- **Resolution**: Clients execute the command on the host and respond via:
  - `POST /v1/host-bash-result` — `{ requestId, stdout, stderr, exitCode, timedOut }`
- **Tracking**: Uses the same `pending-interactions` tracker as approvals, with `kind: "host_bash"`. The endpoint validates the interaction kind before resolving.

### Host file (desktop proxy file operations)

Host file allows the assistant to perform file operations (read, write, edit) on the desktop host machine via the client, rather than in the daemon's own sandbox.

- **Discovery**: Clients discover pending host file requests via SSE events (`host_file_request`) which include a `requestId`.
- **Resolution**: Clients execute the file operation on the host and respond via:
  - `POST /v1/host-file-result` — `{ requestId, content, isError }`
- **Tracking**: Uses the same `pending-interactions` tracker as approvals and host bash, with `kind: "host_file"`. The endpoint validates the interaction kind before resolving.

### Host CU (desktop proxy computer-use execution)

Host CU allows the assistant to proxy computer-use actions (screenshots, mouse/keyboard input) to the desktop host via the client, following the same pattern as host bash and host file.

- **Discovery**: Clients discover pending host CU requests via SSE events (`host_cu_request`) which include a `requestId`.
- **Resolution**: Clients execute the CU action on the host and respond via:
  - `POST /v1/host-cu-result` — `{ requestId, axTree?, axDiff?, screenshot?, screenshotWidthPx?, screenshotHeightPx?, screenWidthPt?, screenHeightPt?, executionResult?, executionError?, secondaryWindows?, userGuidance? }`
- **Tracking**: Uses the same `pending-interactions` tracker as the other host proxy types, with `kind: "host_cu"`. Registration happens in `conversation-routes.ts` and the route handler is in `host-cu-routes.ts`.

### Host browser (desktop proxy CDP execution)

Host browser allows the assistant to proxy CDP (Chrome DevTools Protocol) JSON-RPC commands to a browser attached on the desktop host via the client, following the same pattern as host bash, host file, and host CU.

- **Discovery**: Clients discover pending host browser requests via SSE events (`host_browser_request`) which include a `requestId`, `cdpMethod`, optional `cdpParams`, and optional `cdpSessionId`.
- **Resolution**: Clients execute the CDP command against the attached browser and respond via:
  - `POST /v1/host-browser-result` — `{ requestId, content, isError }`
- **Tracking**: Uses the same `pending-interactions` tracker as the other host proxy types, with `kind: "host_browser"`. Registration happens in `conversation-routes.ts` and the route handler is in `host-browser-routes.ts`.

### Host app-control (desktop proxy native-app control)

Host app-control allows the assistant to proxy app-control actions (target a specific application by bundle ID or process name, capture window screenshots, drive UI) to the desktop host via the client, following the same pattern as host bash, host file, host CU, and host browser. App-control sessions are per-conversation, so the proxy reference lives on `Conversation.hostAppControlProxy` rather than as a singleton.

- **Discovery**: Clients discover pending host app-control requests via SSE events (`host_app_control_request`) which include a `requestId`.
- **Resolution**: Clients execute the app-control action on the host and respond via:
  - `POST /v1/host-app-control-result` — `{ requestId, state, pngBase64?, windowBounds?, executionResult?, executionError? }`. `state` is one of `"running" | "missing" | "minimized"`.
- **Tracking**: Uses the same `pending-interactions` tracker as the other host proxy types, with `kind: "host_app_control"`. The route handler is in `host-app-control-routes.ts` and forwards the payload to the owning conversation's `hostAppControlProxy.resolve()`. Late delivery is tolerated — the route returns 200 even when no pending interaction matches (e.g. the conversation was disposed before the client reported back).

### `chrome-extension` interface (Phase 2)

The `chrome-extension` interface in `INTERFACE_IDS` is a non-interactive transport that supports only the `host_browser` capability — it does NOT support `host_bash`, `host_file`, or `host_cu`. This is encoded in `supportsHostProxy(id, capability)`: passing a capability argument returns `true` for `chrome-extension` only when the capability is `host_browser`; the no-arg form returns `false` for `chrome-extension` (so legacy desktop-only call sites that assume full-desktop proxy availability continue to gate correctly).

For **self-hosted** deployments, `host_browser_request` frames are routed through the `ChromeExtensionRegistry` singleton (`runtime/chrome-extension-registry.ts`), which tracks active chrome-extension WebSocket connections keyed by `(guardianId, clientInstanceId)`. The registry is populated on WebSocket `open` and drained on `close` inside `http-server.ts`'s `/v1/browser-relay` handlers — see the `wsType === "browser-relay"` branches. For **cloud/platform-hosted** deployments, the chrome extension connects via SSE (`GET /v1/events` with `X-Vellum-Interface-Id: chrome-extension`) and `host_browser_request` frames travel through `assistantEventHub` to the SSE stream. The extension POSTs results back to `POST /v1/host-browser-result`. Transport selection is handled by `HostBrowserProxy`, which publishes events to the `assistantEventHub` with `targetCapability: "host_browser"` — the hub delivers to whichever subscriber (chrome-extension or macOS client) has the `host_browser` capability. For macOS, `host_browser_request` frames travel through `assistantEventHub` (SSE) by default; when the guardian also has an active extension connection, the registry-routed WebSocket sender takes precedence.

A single guardian may have multiple parallel extension installs connected at once (two Chrome profiles, two desktops sharing a sync identity). Each install generates a stable `clientInstanceId` on first run, persists it in `chrome.storage.local`, and sends it on every WebSocket handshake as a query param (`clientInstanceId=...`) or header (`x-client-instance-id`). The registry keys inner entries by that id so sibling installs don't evict each other on register/unregister. The default `send(guardianId, msg)` path routes to whichever instance has the most recent activity (`lastActiveAt`); `sendToInstance(guardianId, clientInstanceId, msg)` pins a specific install. Older extension builds that omit the id get a connection-scoped `legacy:<connectionId>` fallback key so they degrade gracefully to single-instance semantics.

`Conversation.hostBrowserSenderOverride` is the integration point between the turn layer and the proxy. When any turn enters the routes layer and the guardian has an active extension connection in the `ChromeExtensionRegistry`, `conversation-routes.ts` resolves the registry entry and sets the override to a sender that writes to that WebSocket. This applies to chrome-extension turns (where the registry is the only transport) and macOS turns (where the extension connection lets browser tools route through the user's real Chrome session instead of cdp-inspect/local). `Conversation.restoreBrowserProxyAvailability()` re-threads the override on queue drain — without this, the drain path would clobber the registry-routed sender with the default `sendToClient` (pointed at the SSE hub) and `host_browser_request` frames would stop reaching the extension mid-queue.

Capability token bootstrap for self-hosted deployments is handled by the gateway (`gateway/src/http/routes/browser-extension-pair.ts`) which mints a guardian-bound HMAC capability token. The daemon delegates token verification to the gateway via IPC (`verify_capability_token`) — it must never read secrets from `GATEWAY_SECURITY_DIR` or any other gateway-owned directory. Cloud deployments issue guardian-bound JWTs via the gateway's WorkOS-backed flow.

See `docs/browser-use-architecture-phase2.md` for the full wire diagram and component inventory.

### Canonical browser backend precedence (macOS)

On macOS-originated turns, the CDP factory (`tools/browser/cdp-client/factory.ts`) evaluates three browser backends in strict priority order. Each candidate is tried lazily; if the first command fails with a transport-level error, the factory falls over to the next candidate. CDP protocol errors (the browser understood the command but rejected it) do NOT trigger failover.

| Priority | Backend                    | Condition                                                                                                                                                                                           | Transport                                                                                                                                      |
| -------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | **Extension / host proxy** | `hostBrowserProxy` present AND `isAvailable()` returns `true`. On macOS, the proxy is always provisioned. On other interfaces, requires an active hub subscriber with `host_browser` capability     | WS via `ChromeExtensionRegistry` (self-hosted), SSE via `assistantEventHub` with `targetCapability: "host_browser"` (cloud extension or macOS) |
| 2        | **cdp-inspect**            | (a) `hostBrowser.cdpInspect.enabled` is `true` in config, OR (b) `transportInterface === "macos"` AND `desktopAuto.enabled` is `true` (default) AND the cooldown from a prior failure is not active | Direct CDP WebSocket to `localhost:9222`                                                                                                       |
| 3        | **Local**                  | Always present as the final fallback                                                                                                                                                                | In-process Playwright CDP via `browserManager`                                                                                                 |

**Transport selection for the extension/host-proxy backend:**

The "extension" backend label is a misnomer inherited from the original Phase 2 design where only the Chrome Extension provided host-browser access. In the current architecture, two transports can power this backend:

- **Extension WebSocket** (self-hosted): When the `ChromeExtensionRegistry` has an active entry for the guardian, the registry-routed sender delivers frames over the `/v1/browser-relay` WebSocket to the Chrome extension, which executes CDP commands via `chrome.debugger`.
- **Extension SSE** (cloud/platform): When no WebSocket entry exists, `HostBrowserProxy.send()` publishes to `assistantEventHub` with `targetCapability: "host_browser"`. The hub delivers the event to the chrome-extension subscriber (which registered with that capability via SSE). The extension POSTs results back to `/v1/host-browser-result`. This path is used for any `canServiceSseBrowser()` interface (`web`, `chrome-extension`, `macos`).
- **macOS SSE bridge**: When the macOS desktop client is connected but no extension is present, the same hub publish with `targetCapability: "host_browser"` delivers to the macOS subscriber (which has all host-proxy capabilities). The desktop client executes CDP commands against the local Chrome and POSTs results back to `/v1/host-browser-result`.

All three transports use the same `HostBrowserProxy` → `ExtensionCdpClient` pipeline. The `browser_status` output distinguishes the transport via the `details.transport` field: `"extension-ws"` or `"macos-sse"`.

**Fallback criteria for cdp-inspect (desktop-auto):**

- On macOS, `desktopAuto.enabled` defaults to `true`, so cdp-inspect is attempted even when the top-level `cdpInspect.enabled` is `false`.
- If the cdp-inspect probe fails (Chrome was not launched with `--remote-debugging-port`, or the endpoint is unreachable), the factory records a cooldown timestamp (`desktopAuto.cooldownMs`, default 30 seconds).
- While the cooldown is active, subsequent macOS turns skip the cdp-inspect candidate entirely and go straight to local, bounding the per-call latency penalty to one `probeTimeoutMs` (default 500ms) per cooldown window.
- The cooldown only applies to desktop-auto candidates (reason starts with `"desktopAuto:"`). Explicitly configured cdp-inspect (`enabled: true`) is never cooldown-suppressed.

**After the first successful CDP command**, the selected backend becomes **sticky** for the remainder of the tool invocation. Subsequent commands always route through the same backend so multi-command tool flows do not hop transports mid-step.

### Per-tool `browser_mode` override

All CDP-backed browser tools (`browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_select_option`, `browser_wait_for`, `browser_extract`, `browser_fill_credential`, `browser_attach`, `browser_detach`, `browser_close`, `browser_status`) accept an optional `browser_mode` input parameter that overrides the automatic backend selection for that invocation.

| Value            | Behavior                                                                     |
| ---------------- | ---------------------------------------------------------------------------- |
| `auto` (default) | Existing priority-ordered fallback: extension -> cdp-inspect -> local        |
| `extension`      | Pin to extension/host-proxy backend. Fails immediately if proxy unavailable. |
| `cdp-inspect`    | Pin to CDP inspect/debugger backend. Fails if endpoint unreachable.          |
| `local`          | Pin to local Playwright-managed browser. No fallback.                        |
| `cdp-debugger`   | Alias for `cdp-inspect`.                                                     |
| `playwright`     | Alias for `local`.                                                           |

**Strict pinned-mode semantics**: When `browser_mode` is set to a specific backend (not `auto`), the factory builds exactly one candidate and disables failover. If the pinned backend is unavailable, the tool returns a detailed error including:

- The requested mode
- An ordered list of attempted backends with exact failure reasons
- A remediation checklist tailored by backend, failure code, and transport (e.g. for macOS SSE: "Verify the Vellum desktop app is running"; for extension: "Ensure Chrome is running with the extension paired")

**Auto-mode fallback logging**: In auto mode, fallback transitions are logged at `warn` level with structured metadata including the full candidate sequence and per-candidate failure reasons. This ensures fallback events are always observable in production logs.

**Test coverage:** Regression tests for `browser_mode` wiring live in `__tests__/headless-browser-mode.test.ts`. E2E regression tests for backend precedence live in `__tests__/host-browser-e2e-cloud.test.ts` (extension path and macOS SSE bridge path) and `__tests__/conversation-routes-disk-view.test.ts` (macOS fallback path). Unit tests for pinned candidate construction and failover live in `tools/browser/cdp-client/__tests__/factory.test.ts`. Browser status tests covering macOS host-browser diagnostics live in `tools/browser/__tests__/browser-status.test.ts`.

### Channel approvals (Telegram, Slack)

Channel approval flows use `requestId` (not `runId`) as the primary identifier:

- Telegram callback buttons encode `apr:<requestId>:<action>` in `callback_data`.
- Guardian approval records in `channelGuardianApprovalRequests` link via `requestId`.
- The conversational approval engine classifies user intent and resolves via `conversation.handleConfirmationResponse(requestId, decision)`.

## Rate Limiting & Diagnostics

All `/v1/*` endpoints share a per-client-IP sliding-window rate limiter (`middleware/rate-limiter.ts`):

- **Authenticated**: 300 requests/minute
- **Unauthenticated**: 20 requests/minute

When the limit is exceeded, the limiter returns 429 and logs a structured warning (module: `rate-limiter`) with the denied endpoint and a breakdown of which endpoints consumed the budget in the current window. This makes it easy to identify whether the cause is rapid conversation switching, polling, or unexpected request volume.

Logs are written to `~/.vellum/workspace/data/logs/vellum.log` by default. If `logFile.dir` is configured, logs rotate daily as `assistant-YYYY-MM-DD.log` in that directory. To watch rate limit events in real time:

```bash
tail -f ~/.vellum/workspace/data/logs/vellum.log | grep rate-limit
```

The provider-level rate limiter (`providers/ratelimit.ts`) also logs warnings (module: `rate-limit`) when request rate or token budget limits are enforced.

## HTTP-Only Transport

HTTP is the sole transport for client-daemon communication. The runtime HTTP server (`assistant/src/runtime/http-server.ts`) is the canonical API surface. Clients connect via HTTP for request/response operations and SSE (`GET /v1/events`) for streaming server-to-client events.

When writing skills that need to call daemon configuration endpoints, use `curl` with the runtime HTTP API (JWT-authenticated via `Authorization: Bearer <jwt>`). The assistant already knows how to use `curl`.
