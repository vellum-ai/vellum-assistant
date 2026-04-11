# Runtime — Agent Instructions

## HTTP API Patterns

### Sending messages

The single HTTP send endpoint is `POST /v1/messages`. Key behaviors:

- **Queue if busy**: When the conversation is processing, messages are queued and processed when the current agent turn completes. No 409 rejections.
- **Fire-and-forget**: Returns `202 { accepted: true }` immediately. The client observes progress via SSE (`GET /v1/events`).
- **Hub publishing**: All agent events are published to `assistantEventHub`, making them observable via SSE.

Do NOT add new send endpoints. All message ingress should go through `POST /v1/messages` (HTTP).

### Approvals (confirmations, secrets, trust rules)

Approvals are **orthogonal to message sending**. The assistant asks for approval whenever it needs one — this is a separate concern from how a message enters the system.

- **Discovery**: Clients discover pending approvals via SSE events (`confirmation_request`, `secret_request`) which include a `requestId`.
- **Resolution**: Clients respond via standalone endpoints keyed by `requestId`:
  - `POST /v1/confirm` — `{ requestId, decision, selectedPattern?, selectedScope? }`. Valid decisions: `"allow"`, `"allow_10m"`, `"allow_conversation"`, `"deny"`, `"always_allow"`, `"always_deny"`, `"always_allow_high_risk"`. For persistent decisions (`always_allow`, `always_deny`, `always_allow_high_risk`), `selectedPattern` and `selectedScope` are validated against the server-provided allowlist/scope options from the original confirmation request before trust rules are persisted.
  - `POST /v1/secret` — `{ requestId, value, delivery }`
  - `POST /v1/trust-rules` — `{ requestId, pattern, scope, decision, allowHighRisk? }`. Validates pattern/scope against server-provided options. Does not resolve the confirmation itself.
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

### `chrome-extension` interface (Phase 2)

The `chrome-extension` interface in `INTERFACE_IDS` is a non-interactive transport that supports only the `host_browser` capability — it does NOT support `host_bash`, `host_file`, or `host_cu`. This is encoded in `supportsHostProxy(id, capability)`: passing a capability argument returns `true` for `chrome-extension` only when the capability is `host_browser`; the no-arg form returns `false` for `chrome-extension` (so legacy desktop-only call sites that assume full-desktop proxy availability continue to gate correctly).

Unlike the SSE-based host proxies used by the macOS client, `host_browser_request` frames for the chrome-extension interface do NOT travel through `assistantEventHub`. Instead they are routed through the `ChromeExtensionRegistry` singleton (`runtime/chrome-extension-registry.ts`), which tracks active chrome-extension WebSocket connections keyed by `(guardianId, clientInstanceId)`. The registry is populated on WebSocket `open` and drained on `close` inside `http-server.ts`'s `/v1/browser-relay` handlers — see the `wsType === "browser-relay"` branches.

A single guardian may have multiple parallel extension installs connected at once (two Chrome profiles, two desktops sharing a sync identity). Each install generates a stable `clientInstanceId` on first run, persists it in `chrome.storage.local`, and sends it on every WebSocket handshake as a query param (`clientInstanceId=...`) or header (`x-client-instance-id`). The registry keys inner entries by that id so sibling installs don't evict each other on register/unregister. The default `send(guardianId, msg)` path routes to whichever instance has the most recent activity (`lastActiveAt`); `sendToInstance(guardianId, clientInstanceId, msg)` pins a specific install. Older extension builds that omit the id get a connection-scoped `legacy:<connectionId>` fallback key so they degrade gracefully to single-instance semantics.

`Conversation.hostBrowserSenderOverride` is the integration point between the turn layer and the registry. When any turn enters the routes layer and the guardian has an active extension connection in the `ChromeExtensionRegistry`, `conversation-routes.ts` resolves the registry entry and sets the override to a sender that writes to that WebSocket. This applies to chrome-extension turns (where the registry is the only transport) and macOS turns (where the extension connection lets browser tools route through the user's real Chrome session instead of cdp-inspect/local). `Conversation.restoreBrowserProxyAvailability()` re-threads the override on queue drain — without this, the drain path would clobber the registry-routed sender with the default `sendToClient` (pointed at the SSE hub) and `host_browser_request` frames would stop reaching the extension mid-queue.

Capability token bootstrap for self-hosted deployments is handled by `routes/browser-extension-pair-routes.ts` (loopback-only; mints a guardian-bound HMAC capability token via `capability-tokens.ts`). Cloud deployments issue guardian-bound JWTs via the gateway's WorkOS-backed flow — `browser-extension-pair-routes.ts` is not involved.

See `docs/browser-use-architecture-phase2.md` for the full wire diagram and component inventory.

### Canonical browser backend precedence (macOS)

On macOS-originated turns, the CDP factory (`tools/browser/cdp-client/factory.ts`) evaluates three browser backends in strict priority order. Each candidate is tried lazily; if the first command fails with a transport-level error, the factory falls over to the next candidate. CDP protocol errors (the browser understood the command but rejected it) do NOT trigger failover.

| Priority | Backend         | Condition                                                                                                                                                                                           | Source                                                                                 |
| -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1        | **Extension**   | `hostBrowserProxy` present AND `isAvailable()` returns `true` (registry-routed WebSocket is connected)                                                                                              | `ChromeExtensionRegistry` via `resolveHostBrowserSender()` in `conversation-routes.ts` |
| 2        | **cdp-inspect** | (a) `hostBrowser.cdpInspect.enabled` is `true` in config, OR (b) `transportInterface === "macos"` AND `desktopAuto.enabled` is `true` (default) AND the cooldown from a prior failure is not active | Config + `desktopAuto` policy in factory                                               |
| 3        | **Local**       | Always present as the final fallback                                                                                                                                                                | Playwright sacrificial-profile browser managed by `browserManager`                     |

**Fallback criteria for cdp-inspect (desktop-auto):**

- On macOS, `desktopAuto.enabled` defaults to `true`, so cdp-inspect is attempted even when the top-level `cdpInspect.enabled` is `false`.
- If the cdp-inspect probe fails (Chrome was not launched with `--remote-debugging-port`, or the endpoint is unreachable), the factory records a cooldown timestamp (`desktopAuto.cooldownMs`, default 30 seconds).
- While the cooldown is active, subsequent macOS turns skip the cdp-inspect candidate entirely and go straight to local, bounding the per-call latency penalty to one `probeTimeoutMs` (default 500ms) per cooldown window.
- The cooldown only applies to desktop-auto candidates (reason starts with `"desktopAuto:"`). Explicitly configured cdp-inspect (`enabled: true`) is never cooldown-suppressed.

**After the first successful CDP command**, the selected backend becomes **sticky** for the remainder of the tool invocation. Subsequent commands always route through the same backend so multi-command tool flows do not hop transports mid-step.

**Test coverage:** E2E regression tests for this precedence order live in `__tests__/host-browser-e2e-cloud.test.ts` (extension path) and `__tests__/conversation-routes-disk-view.test.ts` (macOS fallback path). Unit tests for candidate list construction and failover live in `tools/browser/cdp-client/__tests__/factory.test.ts`.

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
