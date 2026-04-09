# Browser Use Architecture — Phase 2

This doc describes the architecture of **Phase 2 browser use**: the Chrome
extension transport that lets the assistant drive a browser on the user's
machine via CDP (Chrome DevTools Protocol) JSON-RPC, without bundling a
headful Chromium.

Phase 2 replaces the legacy `ExtensionCommand` action dispatch
(`evaluate`, `navigate`, `screenshot`, …) with a generic, future-proof
`host_browser_request` / `host_browser_result` envelope pair that carries
raw CDP method names and params. The action dispatch remains in place
under a feature flag so existing installs continue to work unchanged.

## Overview

Phase 2 ships:

1. A Chrome extension that acts as a CDP JSON-RPC proxy, attaching
   `chrome.debugger` to the active tab and forwarding CDP commands from
   the assistant.
2. Two transports between the extension and the assistant runtime:
   - **Cloud**: WSS to the gateway's `/v1/browser-relay` endpoint, using
     a guardian-bound JWT minted via WorkOS-backed
     `chrome.identity.launchWebAuthFlow`.
   - **Self-hosted**: WS to the local daemon's `/v1/browser-relay`
     endpoint on `127.0.0.1`, using a scoped capability token bootstrapped
     via Chrome Native Messaging.
3. A new `chrome-extension` interface in `INTERFACE_IDS` that routes
   `host_browser_request` frames through a `ChromeExtensionRegistry`
   singleton instead of the SSE hub used by the macOS client.
4. A per-capability `supportsHostProxy(id, capability)` so the
   chrome-extension interface can advertise `host_browser` without
   implying that bash / file / CU proxies are also available.

Consumers of the new envelope (notably the `browser-execution.ts` tool
code that drives live navigation) are scheduled for Phase 3 — Phase 2
only ships the scaffold and the proxy plumbing, plus a feature-flagged
CDP proxy in the extension so we can test it end-to-end against a
real guardian.

## Architecture

The two transports share the same envelope vocabulary and the same
registry/proxy code path on the runtime side. Only the transport layer
and the handshake differ.

```
 ┌───────────────────────┐
 │  Chrome extension     │
 │  (service worker)     │
 │                       │
 │  host-browser-dispatcher
 │   + cdp-proxy         │
 │   + relay-connection  │
 └──────────┬────────────┘
            │ WS (self-hosted)     WSS (cloud)
            │                      │
            ▼                      ▼
    127.0.0.1:<port>         api.vellum.ai
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
          │  ChromeExtensionRegistry   │  (guardianId → ws)
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

Result envelopes flow back via `POST /v1/host-browser-result`, which
resolves the pending interaction keyed by `requestId` and feeds the
result into the current agent turn exactly like the macOS host proxies
do.

## Cloud transport

The cloud transport is used by users who do **not** run their own
assistant. The extension talks to the production gateway directly and
the runtime runs on infrastructure managed by Vellum.

Handshake:

1. The user clicks "Sign in with Vellum (cloud)" in the extension
   popup.
2. The service worker (not the popup) runs
   `chrome.identity.launchWebAuthFlow` against the gateway's WorkOS
   OIDC endpoint. Running it in the service worker keeps the awaited
   promise alive if the popup closes mid-flow.
3. On success, the gateway returns a guardian-bound JWT and the
   extension persists it via `cloud-auth.ts::getStoredToken`.
4. The extension opens `wss://api.vellum.ai/v1/browser-relay` with the
   JWT as the `Authorization: Bearer …` header.
5. The gateway verifies the JWT, extracts the guardian id, and forwards
   the upgrade to the assistant runtime. The runtime registers the
   connection under that guardian id in the `ChromeExtensionRegistry`.

## Self-hosted transport

The self-hosted transport is used by users who run the assistant
locally on their own machine (the default desktop experience). The
extension talks directly to the local daemon over loopback.

Handshake:

1. The user clicks "Pair with Vellum (self-hosted)" in the extension
   popup.
2. The service worker calls
   `chrome.runtime.connectNative("com.vellum.daemon")`, which spawns
   `clients/chrome-extension-native-host/` (a tiny CLI helper bundled
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
4. The extension persists the token and opens
   `ws://127.0.0.1:<port>/v1/browser-relay` with the token as a bearer
   header.
5. The daemon verifies the token via
   `verifyHostBrowserCapability`, registers the connection in the
   `ChromeExtensionRegistry`, and starts routing `host_browser_request`
   frames to it.

`/v1/browser-extension-pair` is loopback-only and refuses requests
from any non-private peer. The capability token is HMAC-SHA256 signed
with a long-lived random secret persisted under `~/.vellum/protected/`
with 0600 permissions (see `capability-tokens.ts`).

## Components

The new modules that implement Phase 2:

- **`assistant/src/runtime/chrome-extension-registry.ts`** — Singleton
  tracking active `chrome-extension` WebSocket connections keyed by
  guardian id. Reconnects from the same guardian supersede the prior
  entry, closing the older socket cleanly.
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
  hands results to the worker for POST-back.
- **`clients/chrome-extension/background/relay-connection.ts`** —
  WebSocket relay with heartbeat, reconnect-with-token-refresh, and
  mode-aware bearer injection.
- **`clients/chrome-extension-native-host/`** — Native messaging helper
  binary that bootstraps the self-hosted capability token.

Runtime wiring:

- `http-server.ts` open/close handlers for `/v1/browser-relay` register
  the connection in `ChromeExtensionRegistry` on open and unregister on
  close.
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

## Phase 2 → Phase 3 hand-off

Work explicitly deferred to Phase 3:

- Migration of `browser-execution.ts` to consume `host_browser_request`
  envelopes directly instead of the legacy `ExtensionCommand` dispatch.
- Cloud-side `host_browser_result` inbound routing on the gateway
  WebSocket (today the extension POSTs results directly to the runtime;
  in cloud mode this goes through the gateway).
- Deriving `x-guardian-id` from the edge JWT inside the gateway rather
  than trusting it from the runtime headers.
- Production extension allowlist: today the native messaging helper,
  the assistant's pair endpoint, and the macOS `NativeMessagingInstaller`
  all contain a dev placeholder extension id. A sync-guard unit test
  exists to prevent these from drifting before release.

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
- Chrome 146+ `chrome://inspect` attach backend may offer a less
  intrusive UX and is being tracked for Phase 4.
