# Runtime — Agent Instructions

## HTTP API Patterns

### Sending messages

The single HTTP send endpoint is `POST /v1/messages`. Key behaviors:

- **Queue if busy**: When the conversation is processing, messages are queued and processed when the current agent turn completes. No 409 rejections.
- **Fire-and-forget**: Returns `202 { accepted: true }` immediately. The client observes progress via SSE (`GET /v1/events`).
- **Hub publishing**: All agent events are published to `assistantEventHub`, making them observable via SSE.

Do NOT add new send endpoints. All message ingress should go through `POST /v1/messages` (HTTP).

**A user interrupt ends the turn, not the queue.** `POST /v1/conversations/:id/cancel` (Stop / Esc, and the CLI's cancel signal file) aborts the turn in flight; anything the same user queued behind it survives and runs on that turn's drain, because the aborted loop reaches its `finally`, which calls `kickDrainQueue` like any other turn end. `abortConversation` discards the queue only for abort kinds where the conversation itself is going away (dispose, eviction, voice supersession, subagent teardown), and every discarded row a client is showing gets `message_queued_deleted` alongside `generation_cancelled` (echo-suppressed rows are skipped, since they never got a `message_queued` ack to close). Two invariants to keep: an unconditional `queue.clear()` emits no per-row terminal event, so clients keep rendering a queued row whose cancel/steer buttons are dead (DELETE 404s, steer reports `not_processing`) and whose message is silently lost on the next reload; and a teardown must discard even when the processing flag already reads idle, since a turn that cleared the flag can still be unwinding through its awaited turn-boundary commit with a `kickDrainQueue` ahead of it.

### Channel inbound honors "queue if busy" via defer-until-idle

Channel inbound turns (Slack/Telegram/etc. — `processChannelMessageInBackground`) obey the same "process when the current turn completes" contract, but they do **not** route through the conversation's queue. A channel turn delivers its reply back through the provider callback URL (streaming session + `finalizeEventDelivery` + processed/delivery bookkeeping); the queue drain fans replies onto the SSE hub only and performs none of that. So a channel turn that arrives while the conversation is mid-turn is **deferred until the processing lock frees** (`withChannelTurnAdmission` in `routes/inbound-stages/channel-turn-admission.ts`: per-conversation single-flight for FIFO ordering + event-driven `waitForIdle`), then run with its delivery orchestration intact.

**Invariant:** do NOT "fix" this by routing channel turns through `conversation.enqueueMessage` — the drain has no channel-callback delivery, so the reply would run but never reach the channel. A channel turn that still hits `CONVERSATION_BUSY_MESSAGE` (a non-channel turn raced in after admission) is re-scheduled for the channel-retry sweep via `deferRetryUntilIdle` — never `recordProcessingFailure` (which `classifyError` treats as fatal → dead-letter → silent drop, JARVIS-1346). The sweep is itself busy-aware: it `deferRetryUntilIdle`s a retry whose conversation is mid-turn. Busy deferral must **not** burn the retry budget: `deferRetryUntilIdle` pushes `retryAfter` forward but never increments `processingAttempts` and never dead-letters, so a conversation that stays busy across many sweeps re-defers indefinitely rather than dropping the reply at `RETRY_MAX_ATTEMPTS` (~10 min). Crash durability: while the in-memory admission waits, the inbound row sits `pending`; a crash mid-wait is recovered at startup by `recoverOrphanedChannelEvents` (`monitoring/recovery/`), which promotes boot-fenced orphan `pending` rows onto the sweep's `failed` retry path.

**Faithful replay:** the sweep reconstructs a turn from the stored raw payload, so it must produce the SAME turn the live ingress path would have run — not an impoverished one. Two invariants, each learned from a live-path hardening change that originally skipped the sweep: (1) **content fencing** — non-guardian content is wrapped in `<external_content>` via the shared `prepareChannelInboundContent` (`routes/inbound-stages/inbound-content-prep.ts`), used by BOTH `inbound-message-handler.ts` and the sweep; replaying raw, unwrapped text would drop the untrusted-content boundary the model relies on (regression window: #30785 wrapped only the live path). (2) **idempotency key + slackMeta** — the live turn captures its `slackInbound` onto the stored payload (`storeInboundSlackMetadata`) and the sweep replays that EXACT object (`parseStoredSlackInbound`), so `deriveIngressIdempotencyKey` yields a byte-identical `client_message_id` (a replay of an already-persisted turn dedups the agent loop) and full slackMeta survives the replay. Dedup is not enough on its own: on a dedup hit the sweep gates `finalizeEventDelivery` on `isDeduplicatedDeliveryOwnedBySibling` — skipping delivery when a sibling event already owns it, so it never double-posts — and, when the deduped turn crashed before writing any reply, completes it with a fresh run rather than delivering nothing. A `buildReplaySlackInbound` fallback reconstructs the key-bearing fields for payloads stored before the capture existed (regression window: #38378 added the key to the live path only, though the sweep IS the "Slack retry" path it targeted). Any future hardening applied at channel ingress must be mirrored in the sweep, or a retried/recovered turn silently loses it.

### SSE backpressure shedding must be observable

SSE handlers built on `ReadableStream` shed slow subscribers when `controller.desiredSize <= 0` to keep daemon memory bounded. Every shed site must emit a log line + Sentry capture so the daemon-side shed can be time-correlated with the client-side idle watchdog (otherwise stalls are invisible from both sides). See [WHATWG Streams — Backpressure](https://streams.spec.whatwg.org/#pipe-chains) and [Node `monitorEventLoopDelay`](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions).

### GET handler idempotency

GET handlers must be safe and side-effect-free — they must not enqueue background jobs, mutate database state, or trigger writes. If a feature needs server-initiated work in response to a client request, use an explicit POST endpoint or a push-based flow (SSE event → client refetch). See [RFC 9110 §9.2.1 — Safe Methods](https://httpwg.org/specs/rfc9110.html#safe.methods).

Accepted exceptions (stale-while-revalidate caches): a GET handler may kick off a bounded, fire-and-forget background refresh of a generated-content cache when no fresh cache exists, provided the handler itself stays read-only and returns immediately with cached/fallback copy, the refresh is single-flight (concurrent GETs share one regeneration), and a TTL bounds regeneration frequency. Current instances:

- `GET /v1/home/feed` — refreshes the personalized home greeting and suggested-prompt caches via `revalidateHomeContentInBackground()`, which publishes `home_feed_updated` when fresh content lands so clients refetch. This is intentional: home content is generated on demand (when a user actually views Home), never at daemon startup or on a timer.
- `GET /v1/conversation-starters` — enqueues a `generate_conversation_starters` memory job when the starter set is stale, cooldown-gated and deduped against in-flight jobs.

### Approvals (confirmations, secrets, trust rules)

Approvals are **orthogonal to message sending**. The assistant asks for approval whenever it needs one — this is a separate concern from how a message enters the system.

- **Discovery**: Clients discover pending approvals via SSE events (`confirmation_request`, `secret_request`) which include a `requestId`.
- **Resolution**: Clients respond via standalone endpoints keyed by `requestId`:
  - `POST /v1/confirm` — `{ requestId, decision }`. Valid decisions: `"allow"`, `"deny"`. The confirm route resolves the pending interaction and nothing else: durable Always-Allow rules are minted through the gateway trust-rules API (`POST /v1/trust-rules`, also served assistant-scoped), which carries the rule's tool, pattern, and risk. The daemon's own `trust-rules` surface is read-only (`GET /v1/trust-rules` list, `POST /v1/trust-rules/suggest`).
  - `POST /v1/secret` — `{ requestId, value, delivery }`
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
- **Conversation-agnostic observation**: `observeHostScreen()` in `host-observe.ts` issues a `computer_use_observe` request with no conversation, for callers outside an agent turn (`HostCuProxy` only exists inside one). It takes the initiating actor's principal id and reaches only that actor's own `host_cu` clients: `pickSameUserAutoResolve` picks the default target and `enforceSameActorOrErrorResult` gates an explicitly named one, both before the request is registered or broadcast. Its pending interaction carries no `conversationId`, so `host-cu-routes.ts` hands the raw observation fields straight to the waiting caller instead of routing through a conversation's CU proxy. On the desktop side the ordinary `host_cu` executor services the request.

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

### `chrome-extension` interface

The `chrome-extension` interface in `INTERFACE_IDS` is a non-interactive transport that supports only the `host_browser` capability — it does NOT support `host_bash`, `host_file`, or `host_cu`. This is encoded in `supportsHostProxy(id, capability)`: passing a capability argument returns `true` for `chrome-extension` only when the capability is `host_browser`; the no-arg form returns `false` for `chrome-extension` (so legacy desktop-only call sites that assume full-desktop proxy availability continue to gate correctly).

The extension reaches the daemon over the same two doors every client uses. Self-hosted, it pairs once through the gateway's `POST /v1/pair` (`gateway/src/http/routes/pair.ts`: loopback-only, rate-limited, mints an `actor_client_v1` JWT for the `X-Vellum-Interface-Id: chrome-extension` caller); cloud deployments issue the guardian-bound JWT through the gateway's WorkOS-backed flow. It then subscribes to `GET /v1/events` with `X-Vellum-Interface-Id: chrome-extension`, which registers it on `assistantEventHub` with the single `host_browser` capability, and it answers work by POSTing to `POST /v1/host-browser-result`.

`HostBrowserProxy` (`daemon/host-browser-proxy.ts`, a lazily-created singleton) is the only sender: it publishes `host_browser_request` frames to the hub with `targetCapability: "host_browser"` and an explicit target client, choosing that client at send time from the hub's live roster (`resolveTargetClient`). Both the extension and the macOS desktop bridge register `host_browser`, so ordering is method-aware rather than pure recency: `Vellum.*` pseudo-methods (tabs, attach, detach) go only to a chrome-extension client, the only transport that implements them; raw CDP methods prefer a chrome-extension client over the macOS bridge, most recently active first within each group; an explicit `targetClientId` pins one client; and when a `sourceActorPrincipalId` is supplied only that actor's clients are eligible. Several extension installs for one guardian are simply several `host_browser` clients on the roster. A dispatch that lands during a brief MV3 service-worker reconnect waits up to `EXTENSION_RECONNECT_GRACE_MS` before failing.

Nothing in the turn layer wires the proxy: it reads the roster on every send, and the conversation's own event sink is fixed for its life (see `assistant/AGENTS.md`, "Conversation event delivery and turn presence"), so a queued or drained turn reaches the extension exactly like a live one.

See `docs/browser-use-architecture-phase2.md` for the backend scenarios and the manual QA checklist.

### Canonical browser backend precedence (macOS)

On macOS-originated turns, the CDP factory (`tools/browser/cdp-client/factory.ts`) evaluates three browser backends in strict priority order. Each candidate is tried lazily; if the first command fails with a transport-level error, the factory falls over to the next candidate. CDP protocol errors (the browser understood the command but rejected it) do NOT trigger failover.

| Priority | Backend                    | Condition                                                                                                                                                                                                                                                                                                                      | Transport                                                                                 |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1        | **Extension / host proxy** | Two candidates from the always-present `HostBrowserProxy` singleton: `extension` when `hasExtensionClient(actor)` finds a chrome-extension client on the hub; otherwise `host-bridge` when `isAvailable(actor)` finds any `host_browser` client (the macOS desktop bridge) and that actor's host-bridge cooldown is not active | SSE via `assistantEventHub` with `targetCapability: "host_browser"`, to the chosen client |
| 2        | **cdp-inspect**            | (a) `hostBrowser.cdpInspect.enabled` is `true` in config, OR (b) `transportInterface === "macos"` AND `desktopAuto.enabled` is `true` (default) AND the cooldown from a prior failure is not active                                                                                                                            | Direct CDP WebSocket to `localhost:9222`                                                  |
| 3        | **Local**                  | Always present as the final fallback                                                                                                                                                                                                                                                                                           | In-process Playwright CDP via `browserManager`                                            |

**Transport selection for the extension/host-proxy backend:**

The "extension" backend label predates the macOS bridge; two SSE transports power it, both through the same `HostBrowserProxy` → `ExtensionCdpClient` pipeline:

- **Chrome extension**: `HostBrowserProxy.send()` publishes to `assistantEventHub` with `targetCapability: "host_browser"`, targeting the chrome-extension client `resolveTargetClient` chose (see the interface section above); the extension executes the CDP command via `chrome.debugger` and POSTs the result to `/v1/host-browser-result`.
- **macOS SSE bridge**: when no chrome-extension client is eligible, the same publish targets the macOS subscriber (which registers every host-proxy capability); the desktop client executes the command against the local Chrome and POSTs the result the same way.

In the CDP factory the bridge is the internal `"host-bridge"` candidate kind (`InternalBrowserMode`, never a caller-pinnable `browser_mode`). `browser_status` labels the extension path `details.transport: "extension-ws"`; the label predates the SSE transport and is kept as-is.

**Host-bridge cooldown:** a `host-bridge` transport failure records a per-actor cooldown (`recordHostBridgeCooldown`, keyed by `sourceActorPrincipalId`, `__default__` when unresolved) for the same `desktopAuto.cooldownMs` window; while it is active the factory skips the bridge candidate (log `CDP factory: host-bridge skipped (cooldown active)`) and the turn drops straight to cdp-inspect/local. Per-actor because on a multi-actor cloud daemon the bridge reaches a different desktop per actor, so one actor's missing debug port must not suppress another's only route to their Chrome. Never applies to the `extension` candidate.

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

**Test coverage:** Regression tests for `browser_mode` wiring live in `__tests__/headless-browser-mode.test.ts`. Route-wiring coverage for the macOS fallback path lives in `__tests__/conversation-routes-disk-view.test.ts`, which asserts a macOS turn carries its interface context rather than exercising the backends themselves. Unit tests for pinned candidate construction and failover live in `tools/browser/cdp-client/__tests__/factory.test.ts`. Browser status tests covering macOS host-browser diagnostics live in `tools/browser/__tests__/browser-status.test.ts`.

### Interactive requests on channels (approvals, questions)

**The guardian-request pipeline is the canonical rail for anything interactive on a channel** — cards with buttons, request-code replies, emoji reactions, typed answers. The end-to-end map (promotion → gateway `guardian_requests` row → notification broadcaster → per-channel adapters → reply router → decision primitive → per-kind resolver) lives in [docs/guardian-request-flow.md](../../docs/guardian-request-flow.md). New interactive features extend that pipeline's seams; do NOT add per-feature watchers, callback schemes, or inbound intercepts.

Identifiers and plumbing notes:

- Channel flows use `requestId` (not `runId`) as the primary identifier. Callback buttons encode `apr:<requestId>:<action>` in `callback_data`; answer-option buttons on question cards use action tokens `answer_<idx>` / `answer_skip` under the same prefix.
- Guardian request records live in the gateway-owned `guardian_requests` table (and their `guardian_request_deliveries`); the daemon reads/writes them through the `channels/gateway-guardian-requests.ts` client.
- Legacy in-turn interception (`routes/guardian-approval-interception.ts` + the approval prompt watcher) still serves a guardian's own tool-approval prompts mid-turn, resolving via `conversation.handleConfirmationResponse(requestId, decision)`. It is a legacy rail — the reply router runs first; converge new work on the pipeline.

### Message metadata vocabulary

Several differently-scoped things are called metadata on the channel path, and
they nest, so a name that fits two of them reads as one concept. Counterpart to
the gateway's Channel Identity Vocabulary, which covers the wire side.

- **`sourceMetadata`** describes an inbound event in flight on the gateway to
  daemon wire (`SourceMetadataSchema`, `packages/gateway-client`): provider
  ids, trust verdict, admission policy. It is also persisted verbatim on the
  stored inbound payload, because the retry sweep replays that payload and has
  to reconstruct the same turn (`channel-retry-sweep.ts`).
- **`messages.metadata`** is the stored envelope on a row. Everything below is
  a key inside it. `messageMetadataSchema` (`persistence/conversation-crud.ts`)
  describes its shared keys; it is parsed where a reader needs them, not
  enforced on every write.
- **`buildChannelMetadata`** (`routes/channel-metadata.ts`) builds the turn's
  portion of that envelope: provenance, `userMessageChannel`, interfaces,
  attachments. Callers spread it and add channel-specific keys alongside, so it
  is a producer of the envelope, never a key within it.
- **`slackMeta`** is the per-row key describing what a row is in its Slack
  conversation: `channelTs` for the row's own id, `threadTs` for its thread,
  `reaction.targetChannelTs` for the message a reaction was attached to, plus
  Slack's own file markers and timezone labels. Most channel-path readers
  still go through it directly; the lookups in `persistence/delivery-crud.ts`
  read through `readProviderMetadata` instead, which serves this envelope and
  the neutral shape below from one call.
- **`providerMeta`** is the channel-neutral counterpart of that key
  (`messaging/provider-message-metadata.ts`): `source`,
  `conversationExternalId`, `messageId`, `threadId`, `actorExternalId`,
  `eventKind`, the `reaction` sub-key, and the `editedAt` / `deletedAt`
  marks. Deliberately the same vocabulary the inbound wire uses in
  `InboundEventBase`, so a channel that can describe itself at ingress can
  describe its stored rows without a translation of its own. Writable by any
  channel, including one this repo has no code for, which is why a new
  channel belongs here rather than in a sixth key of its own.

  Every channel except Slack writes it: a reaction row carries the whole
  shape (`inbound-stages/reaction-intercept.ts`), and an edit or a delete
  stamps `editedAt` / `deletedAt` onto whatever the row already said about
  itself through `mergeProviderMessageMetadata`
  (`inbound-stages/edit-intercept.ts`, `inbound-message-handler.ts`). Slack
  keeps writing `slackMeta`, and `readProviderMetadata` maps that envelope
  onto this shape on read, so the channel-agnostic readers in
  `persistence/delivery-crud.ts` (thread evidence, and finding the
  conversation that holds a given provider message id) serve both without a
  per-channel branch.

### Channel verification: gateway-owned

Verification SESSION state (sessions, secrets, rate limits, validate+consume) AND the channel-verified OUTCOME (status / verifiedAt / verifiedVia) are both gateway-owned. The gateway holds the `channel_verification_sessions` + `channel_guardian_rate_limits` tables (`gateway/src/db/session-store.ts`) and mints all secrets in `gateway/src/verification/session-service.ts`; the daemon holds no session or rate-limit state (its legacy tables were dropped by gateway data migration m0014).

The daemon relays session lifecycle operations over the `verification_sessions_*` IPC routes via `assistant/src/channels/gateway-verification-sessions.ts` and keeps what is presentation: message composition and channel delivery (`channel-verification-routes.ts`, `verification-outbound-actions.ts`). `channel-verification-service.ts` retains only guardian-delivery reads (`getGuardianBinding`, `isGuardian`, `isGuardianBoundForChannel`).

The verified outcome is written in-process by the gateway: the HTTP guardian-attest handler calls `ContactStore.markChannelVerified` directly (verifiedVia "manual"); the code-match paths (text and the `verification_sessions_validate_consume` engine route) apply role side effects in-engine — guardian phone binding commits in the same gateway transaction as the consume. The revoke/downgrade outcome is relayed from the daemon via `ipcCallPersistent("mark_channel_revoked", …)` to `ContactStore.markChannelRevoked`.

## Rate Limiting & Diagnostics

Most `/v1/*` endpoints share a per-client-IP sliding-window rate limiter (`middleware/rate-limiter.ts`):

- **Authenticated (loopback)**: 1200 requests/minute — desktop app, CLI, anything on the daemon's own host (`127.0.0.0/8`, `::1`). A cold sidebar load at thousands of conversations legitimately bursts far beyond the remote budget.
- **Authenticated (remote)**: 300 requests/minute — proxied non-loopback clients, keyed by the forwarded client IP. Configurable via `apiRateLimit.authenticatedMaxRequestsPerMinute` (positive integer, defaults to 300 when unset). The budget is seeded at construction and pushed to the live limiter by the config watcher (`refreshAuthenticatedApiRateLimit()`) on a `config.json` change, so an edit applies without a restart and without config-loader work on the per-request path. The loopback and unauthenticated budgets are fixed and unaffected by this setting.
- **Unauthenticated**: 20 requests/minute

**Exempt endpoints** (`isRateLimitExemptEndpoint`): the SSE stream (`events`) and liveness/readiness probes (`health`, `healthz`, `readyz`) bypass the per-minute limiter entirely. The stream is one long-lived connection, not a burst of requests, and 429-ing it drops the stream — which drives a client reconnect + full re-bootstrap loop that generates far more load than the limiter saves. Liveness probes must always answer or the client treats the assistant as down and reconnects harder. The events route still enforces auth downstream, and stream memory is bounded by SSE backpressure shedding + subscriber caps.

When the limit is exceeded, the limiter returns 429 and logs a structured warning (module: `rate-limiter`) with the denied endpoint and a breakdown of which endpoints consumed the budget in the current window. This makes it easy to identify whether the cause is rapid conversation switching, polling, or unexpected request volume.

Logs rotate daily into `$VELLUM_WORKSPACE_DIR/data/logs/assistant-YYYY-MM-DD.log` (or into the directory configured via `logFile.dir`). To watch rate limit events in real time:

```bash
tail -f "$VELLUM_WORKSPACE_DIR/data/logs/assistant-$(date -u +%Y-%m-%d).log" | grep rate-limit
```

The provider-level rate limiter (`providers/ratelimit.ts`) also logs warnings (module: `rate-limit`) when request rate or token budget limits are enforced.

## HTTP-Only Transport

HTTP is the sole transport for client-daemon communication. The runtime HTTP server (`assistant/src/runtime/http-server.ts`) is the canonical API surface. Clients connect via HTTP for request/response operations and SSE (`GET /v1/events`) for streaming server-to-client events.

When writing skills that need to call daemon configuration endpoints, use `curl` with the runtime HTTP API (JWT-authenticated via `Authorization: Bearer <jwt>`). The assistant already knows how to use `curl`.
