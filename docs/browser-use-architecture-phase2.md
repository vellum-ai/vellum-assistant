# Browser Use Architecture — Phase 2

This doc describes the architecture of **Phase 2 browser use**: the Chrome
extension transport that lets the assistant drive a browser on the user's
machine via CDP (Chrome DevTools Protocol) JSON-RPC, without bundling a
headful Chromium.

Phase 2 drives the browser through a generic, future-proof
`host_browser_request` / `host_browser_result` envelope pair that
carries raw CDP method names and params. The chrome-extension service
worker attaches `chrome.debugger` to the active tab and forwards each
CDP command via the `host_browser` host proxy, so the assistant's
browser tools speak plain CDP end-to-end regardless of whether they
are driving a local Playwright-managed Chromium or a user-attached
browser reached over the extension relay.

## Overview

Phase 2 ships:

1. A Chrome extension that acts as a CDP JSON-RPC proxy, attaching
   `chrome.debugger` to the active tab and forwarding CDP commands from
   the assistant.
2. Two transports between the extension and the assistant runtime:
   - **Cloud**: WSS to the gateway's `/v1/browser-relay` endpoint, using
     a guardian-bound JWT minted via WorkOS-backed
     `chrome.identity.launchWebAuthFlow`.
   - **Self-hosted**: WS to the local assistant's `/v1/browser-relay`
     endpoint on `127.0.0.1`, using a scoped capability token bootstrapped
     via Chrome Native Messaging.
3. A new `chrome-extension` interface in `INTERFACE_IDS` that routes
   `host_browser_request` frames through a `ChromeExtensionRegistry`
   singleton instead of the SSE hub used by the macOS client.
4. A per-capability `supportsHostProxy(id, capability)` so the
   chrome-extension interface can advertise `host_browser` without
   implying that bash / file / CU proxies are also available.
5. **Relay keepalive**: The extension sends periodic JSON heartbeat
   frames (`{ type: "keepalive", sentAt: <epoch_ms> }`) every 20 seconds
   to prevent Chrome MV3 service-worker idle suspension (~30 s timeout).
   The runtime acknowledges by touching the connection's activity
   timestamp in the `ChromeExtensionRegistry`.
6. **Silent token maintenance**: On connect, reconnect, and auto-connect,
   the worker transparently re-bootstraps expired/stale local tokens via
   native messaging and refreshes cloud JWTs via non-interactive OAuth —
   no user interaction required unless refresh itself fails.
7. **Extension-first CDP routing**: The CDP client factory always prefers
   the extension transport when it is provisioned. When the extension
   proxy exists but is temporarily unavailable (mid-reconnect), the
   factory intentionally skips `cdp-inspect` to prevent silent backend
   drift. `cdp-inspect` enters the candidate list when no extension proxy
   exists at all (macOS desktop-auto path) or when explicitly enabled in
   config (`hostBrowser.cdpInspect.enabled`), but it is not used as a
   fallback during transient extension disconnects.
8. **Structured connection health**: The worker maintains a six-state
   health machine (`paused`, `connecting`, `connected`, `reconnecting`,
   `auth_required`, `error`) surfaced to the popup via `get_status`.
   The popup renders concise status text and auto-expands the
   Troubleshooting section only when user action is genuinely needed.

`browser-execution.ts` drives the live navigation surface through a
per-invocation `BrowserSessionManager` obtained via `getCdpClient()`
(see `assistant/src/tools/browser/cdp-client/factory.ts`). The
manager picks an extension backend when the conversation has a host
browser proxy bound to it and falls back to a local Playwright-backed
backend otherwise, so tool code remains transport-agnostic.

All CDP-backed tools accept an optional `browser_mode` input parameter
(`auto`, `extension`, `cdp-inspect`/`cdp-debugger`, `local`/`playwright`)
that pins backend selection for that invocation. When a pinned mode
fails, the tool response includes a detailed error with the attempted
backends, exact failure reasons, and a remediation checklist. In auto
mode, fallback transitions are logged at warn level for observability.
See `browser-mode.ts` for normalization and `browser-execution.ts` for
the `acquireCdpClientWithMode` integration point.

## Architecture

The two transports share the same envelope vocabulary and the same
registry/proxy code path on the runtime side. Only the transport layer
and the handshake differ.

```
 ┌─────────────────────────────────┐
 │  Chrome extension               │
 │  (MV3 service worker)           │
 │                                 │
 │  host-browser-dispatcher        │
 │   + cdp-proxy                   │
 │   + relay-connection            │
 │     (keepalive 20s interval)    │
 │     (reconnect 1s–30s backoff)  │
 │     (silent token refresh)      │
 │                                 │
 │  ConnectionHealthState:         │
 │   paused | connecting |         │
 │   connected | reconnecting |    │
 │   auth_required | error         │
 │        │                        │
 │        ▼                        │
 │  popup (get_status)             │
 └──────────┬──────────────────────┘
            │ WS (self-hosted)     WSS (cloud)
            │  + keepalive frames  │
            │                      │
            ▼                      ▼
    127.0.0.1:<port>         <gateway>
    /v1/browser-relay        /v1/browser-relay
            │                      │
            └──────────┬───────────┘
                       │
                       ▼
          ┌────────────────────────────┐
          │  assistant runtime         │
          │  http-server.ts open/close │
          │        │                   │
          │        ▼                   │
          │  ChromeExtensionRegistry   │  (guardianId, clientInstanceId → ws)
          │   .touch() on keepalive    │
          │        │                   │
          │        ▼                   │
          │  HostBrowserProxy          │
          │        │                   │
          │        ▼                   │
          │  pendingInteractions       │
          │        ▲                   │
          │        │ result            │
          │  POST /v1/host-browser-    │
          │   result                   │
          └────────────────────────────┘
```

Result envelopes normally flow back over the same `/v1/browser-relay`
WebSocket as `host_browser_result` frames (cloud + self-hosted). The
runtime resolves these through the same shared resolver used by
`POST /v1/host-browser-result`. The HTTP route remains as a self-hosted
fallback when no relay socket is available.

## Cloud transport

The cloud transport is used by users who do **not** run their own
assistant. The extension talks to the production gateway directly and
the runtime runs on infrastructure managed by Vellum.

Handshake:

1. The user clicks **Connect** in the extension popup. For cloud
   assistants, the worker auto-bootstraps credentials as part of the
   one-click flow — no separate "Sign in" step is needed.
2. The service worker (not the popup) runs
   `chrome.identity.launchWebAuthFlow` against the gateway's WorkOS
   OIDC endpoint. Running it in the service worker keeps the awaited
   promise alive if the popup closes mid-flow.
3. On success, the gateway returns a guardian-bound JWT and the
   extension persists it per-assistant via scoped storage keys.
4. The extension opens `wss://<gateway>/v1/browser-relay` with the
   JWT on the `token=...` query parameter and a `clientInstanceId`
   for multi-install disambiguation.
5. The gateway verifies the JWT, extracts the guardian id, and forwards
   the upgrade to the assistant runtime. The runtime registers the
   connection under `(guardianId, clientInstanceId)` in the
   `ChromeExtensionRegistry`.

Token lifecycle:

- The worker proactively refreshes stale cloud JWTs before they expire,
  both at connect time (`connectPreflight`) and on reconnect
  (`cloudReconnectHook`).
- A non-interactive OAuth refresh is attempted first. If it succeeds the
  relay reconnects silently.
- If non-interactive refresh is impossible (refresh token expired, OAuth
  configuration changed), the reconnect loop aborts and the popup enters
  `auth_required` state. The user must re-sign-in via the Troubleshooting
  controls, then click **Connect**.

## Self-hosted transport

The self-hosted transport is used by users who run the assistant
locally on their own machine (the default desktop experience). The
extension talks directly to the local assistant over loopback.

Handshake:

1. The user clicks **Connect** in the extension popup. For local
   assistants, the worker auto-bootstraps the capability token via
   native messaging as part of the one-click flow — no separate "Pair"
   step is needed.
2. The service worker calls
   `chrome.runtime.connectNative("com.vellum.daemon")`, which spawns
   `clients/chrome-extension/native-host/` (a tiny CLI helper bundled
   into the macOS `.app` at
   `Contents/MacOS/vellum-chrome-native-host`).
3. The helper:
   a. Parses the calling extension's origin from `argv[1]` and rejects
      anything not in `ALLOWED_EXTENSION_IDS`.
   b. Resolves the assistant's HTTP port from (in order)
      `--assistant-port`, `~/.vellum/runtime-port`, then `7821`.
   c. POSTs to `http://127.0.0.1:<port>/v1/browser-extension-pair` to
      mint a scoped capability token bound to the caller's guardian.
   d. Writes a `token_response` frame to stdout and exits.
4. The extension persists the token per-assistant under scoped storage
   keys and opens `ws://127.0.0.1:<port>/v1/browser-relay` with the
   token on the `token=...` query parameter and a `clientInstanceId`
   for multi-install disambiguation.
5. The assistant verifies the token via
   `verifyHostBrowserCapability`, registers the connection under
   `(guardianId, clientInstanceId)` in the `ChromeExtensionRegistry`,
   and starts routing `host_browser_request` frames to it.

Token lifecycle:

- The worker silently re-bootstraps local tokens when they are expired
  or stale, both at connect time (`buildRelayModeForAssistant`) and on
  reconnect (`onReconnect` hook in `createRelayConnection`). The native
  messaging helper is re-spawned to mint a fresh token — no user
  interaction required.
- If the native host is unreachable or the pair endpoint rejects the
  request, the reconnect loop aborts and the popup enters
  `auth_required` state. The user must re-pair via the Troubleshooting
  controls, then click **Connect**.

`/v1/browser-extension-pair` is loopback-only and refuses requests
from any non-private peer. The capability token is HMAC-SHA256 signed
with a long-lived random secret persisted under `~/.vellum/protected/`
with 0600 permissions (see `capability-tokens.ts`).

## Components

The new modules that implement Phase 2:

- **`assistant/src/runtime/chrome-extension-registry.ts`** — Singleton
  tracking active `chrome-extension` WebSocket connections keyed by
  `(guardianId, clientInstanceId)`. Reconnects from the same instance
  supersede only that instance's prior entry, leaving sibling installs
  under the same guardian intact.
- **`assistant/src/runtime/routes/browser-extension-pair-routes.ts`** —
  `POST /v1/browser-extension-pair` endpoint. Loopback-only. Mints a
  capability token bound to the caller's guardian id and the
  `host_browser_command` capability.
- **`assistant/src/runtime/capability-tokens.ts`** — HMAC-SHA256
  capability token mint/verify, plus the secret lifecycle
  (`loadOrCreateCapabilityTokenSecret`, legacy workspace →
  protected-directory migration, mode enforcement on write,
  corruption-triggered regeneration, per-test injection).
- **`assistant/src/browser-session/`** — `BrowserSessionManager` and its
  `extension` + `local` backends. The cdp-client factory constructs a
  per-invocation manager for each browser tool call, which is the single
  choke point for CDP backend selection, session lifetime, and future
  session-invalidation handling.
- **`clients/chrome-extension/background/cdp-proxy.ts`** — CDP JSON-RPC
  wrapper around `chrome.debugger`. Tracks attach state per target so
  concurrent commands don't double-attach.
- **`clients/chrome-extension/background/host-browser-dispatcher.ts`** —
  Consumes `host_browser_request` envelopes, drives the `cdp-proxy`, and
  hands results to the worker for relay-aware delivery (WS first, HTTP
  fallback in self-hosted mode).
- **`clients/chrome-extension/background/relay-connection.ts`** —
  Long-lived WebSocket relay with keepalive heartbeat (20 s interval to
  prevent MV3 idle suspension), exponential-backoff reconnect (1 s base,
  30 s cap), structured reconnect-with-refresh lifecycle (token rotation
  before each reconnect attempt), and mode-aware bearer injection. The
  `onReconnect` hook supports three outcomes: `keep` (reuse token),
  `refreshed` (swap in a new token), or `abort` (stop reconnecting and
  surface auth error to popup).
- **`clients/chrome-extension/background/cloud-reconnect-decision.ts`** —
  Pure decision function for cloud reconnect strategy. Distinguishes
  auth-failure closes (4001/4002/4003/1008) from transient 1006 closes
  and manages a refresh-attempt budget to avoid silently hammering the
  gateway. Covered by direct unit tests.
- **`clients/chrome-extension/native-host/`** — Native messaging helper
  binary that bootstraps the self-hosted capability token. Invoked
  automatically by the service worker during connect, reconnect, and
  auto-connect flows; manual invocation via the popup's Troubleshooting
  controls is reserved for diagnostics when automatic recovery fails.

Runtime wiring:

- `http-server.ts` open/close handlers for `/v1/browser-relay` register
  the connection in `ChromeExtensionRegistry` on open and unregister on
  close. The inbound frame handler dispatches `keepalive` frames to
  `registry.touch(connectionId)` to refresh the connection's activity
  timestamp without log noise.
- `conversation-routes.ts` turn-start wires a registry-routed
  `hostBrowserSenderOverride` onto the `Conversation` so
  `host_browser_request` frames go to the extension WebSocket instead of
  the SSE hub.
- `Conversation.restoreBrowserProxyAvailability()` is called on queue
  drain to re-thread the override — without this, the drain path would
  clobber the registry-routed sender with the default `sendToClient`
  (which points at the SSE hub and nothing else).
- `supportsHostProxy(id, capability)` — chrome-extension returns `true`
  only for `host_browser`; macOS returns `true` for all four (bash,
  file, cu, browser).

Extension-side health wiring:

- The worker maintains a `ConnectionHealthState` enum (`paused`,
  `connecting`, `connected`, `reconnecting`, `auth_required`, `error`)
  with detail fields (last disconnect code, last error message,
  timestamp).
- Health transitions are driven by connect/open/close/pause actions.
  The `onClose` callback transitions to `reconnecting` on unexpected
  disconnects and to `auth_required` when the reconnect hook aborts.
- The popup reads health via the `get_status` message and maps it to
  concise display states via `popup-state.ts` helpers
  (`deriveHealthStatusDisplay`, `shouldExpandTroubleshooting`,
  `healthToPhase`).
- The Troubleshooting section auto-expands only when health is
  `auth_required` or `error` — during `connected`, `reconnecting`, and
  `paused` it stays collapsed to avoid distracting users.

## Open follow-ups

- Production extension allowlist: the native messaging helper, the
  assistant's pair endpoint, and the macOS `NativeMessagingInstaller`
  all contain a dev placeholder extension id pending the first public
  release of the extension. The sync-guard unit test at
  `assistant/src/__tests__/extension-id-sync-guard.test.ts` fails CI
  if any of the three drifts out of sync, so updating the placeholder
  to the production id must touch all three files plus the test
  constant in lockstep.

## Steady-state contract

After the first successful Connect, the extension operates as a
background service with no further user interaction required:

1. **Install once**: Load the extension, ensure the native messaging host
   is installed (the macOS app does this automatically).
2. **Connect once**: Click Connect in the popup. The worker
   auto-bootstraps credentials (local pair token or cloud JWT) as part
   of the single-click flow.
3. **Forget it**: The extension maintains the relay indefinitely.
   Keepalive frames prevent MV3 idle suspension. Exponential-backoff
   reconnect handles transient drops. Silent token refresh re-bootstraps
   credentials when they expire. The `autoConnect` flag persists across
   browser sessions so reopening Chrome automatically reconnects.

Users should only interact with the extension again when:

- They want to **Pause** (intentionally disconnect and disable
  auto-reconnect).
- The popup shows **Action required** (`auth_required` or `error` health
  state), meaning automatic recovery has been exhausted.

The `cdp-inspect` backend is **not** a fallback for transient extension
interruptions. The CDP client factory intentionally skips cdp-inspect
when the extension proxy exists but is temporarily unavailable, giving
the extension's automatic recovery time to restore the connection.
`cdp-inspect` is an advanced, opt-in backend for users who cannot install
the extension or who need broad session-level CDP access; see
[Browser Use — `cdp-inspect` Backend](./browser-use-cdp-inspect-backend.md).

## Known UX considerations

### `chrome.debugger` infobar

When the Chrome extension calls
`chrome.debugger.attach(target, requiredVersion)`, Chrome displays a
persistent yellow infobar at the top of the affected tab saying "Vellum
started debugging this browser." This is an intentional security
mitigation — it cannot be suppressed via the public MV3 API.

Investigation notes (Phase 2):

- `chrome.debugger.attach(target, requiredVersion, callback)` — three-
  argument form, no options parameter. Chrome 120+.
  (https://developer.chrome.com/docs/extensions/reference/api/debugger)
- There is no `{ silent: true }` option on attach.
- The `--silent-debugger-extension-api` command-line flag exists for
  Chromium but (a) requires the user to launch Chrome with the flag,
  (b) is not enabled by default in stable channels, and (c) is not
  something we can enforce on end users.
- Chrome 126+ added `chrome.debugger.attach` acceptance via `targetId`
  / `tabId` but did not add a silent-mode option.
- Closing the infobar does not detach the debugger; it is purely
  informational.

Decision: accept the infobar. The TDD already concluded this; Phase 2
confirms no public API exists to suppress it. End-user messaging in the
Mac app popup should explain that the banner is expected and normal
when Vellum is driving the browser.

Alternatives considered:

- Playwright / `chrome --remote-debugging-port` in a sacrificial profile
  avoids the infobar but requires installing Chromium and is out-of-
  scope (Phase 5).
- The assistant-local `cdp-inspect` backend attaches to an existing
  Chrome instance via `chrome://inspect` / `--remote-debugging-port`
  and avoids the per-tab debugger infobar entirely. It is implemented
  and opt-in via `hostBrowser.cdpInspect.enabled`; see
  [Browser Use — `cdp-inspect` Backend](./browser-use-cdp-inspect-backend.md)
  for setup, security trade-offs, and troubleshooting. Note: the
  `cdp-inspect` backend does **not** activate as a fallback during
  transient extension disconnects — the extension-first routing logic
  in the CDP client factory prevents silent backend drift.
