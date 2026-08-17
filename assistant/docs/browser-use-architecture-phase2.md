# Browser Use Architecture

## Overview

macOS-originated turns choose a browser backend from a three-tier chain, so the assistant prefers the user's real Chrome session over a sandboxed Playwright instance. The top tier, the host browser proxy, has two transports, both riding the SSE event hub:

1. **Chrome Extension**: when the Vellum Chrome Extension is installed and paired, `HostBrowserProxy` publishes `host_browser_request` frames to `assistantEventHub` targeted at the extension's SSE subscription; the extension executes CDP commands through `chrome.debugger` and POSTs results to `/v1/host-browser-result`.
2. **macOS desktop bridge**: when the macOS desktop client is connected but no extension is, the same publish targets the desktop client's SSE subscription; it executes CDP commands against the local Chrome and POSTs results the same way.

When neither is available, the chain falls through to cdp-inspect (direct Chrome DevTools Protocol attach) before resorting to the local Playwright browser.

This document describes the runtime architecture, backend precedence rules, transport matrix, and the manual QA playbook for verifying correct backend selection.

## Component Inventory

| Component                 | Location                                           | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HostBrowserProxy**      | `daemon/host-browser-proxy.ts`                     | Lazily-created singleton. Publishes `host_browser_request` frames to the hub with `targetCapability: "host_browser"` and an explicit target client chosen at send time (`resolveTargetClient`), then awaits the matching `host_browser_result`. `Vellum.*` pseudo-methods go only to a chrome-extension client; raw CDP prefers an extension client over the macOS bridge; `targetClientId` pins one; `sourceActorPrincipalId` restricts to that actor's clients. |
| **events-routes.ts**      | `runtime/routes/events-routes.ts`                  | `GET /v1/events`: registers each SSE client on the hub with the capabilities its `X-Vellum-Interface-Id` supports (`host_browser` for `chrome-extension`; every host-proxy capability for `macos`).                                                                                                                                                                                                                                                               |
| **pair.ts**               | `gateway/src/http/routes/pair.ts`                  | `POST /v1/pair`: loopback-only, rate-limited pairing that mints the extension's `actor_client_v1` JWT for self-hosted deployments. Cloud deployments issue the guardian-bound JWT through the gateway's WorkOS-backed flow.                                                                                                                                                                                                                                       |
| **CDP Factory**           | `tools/browser/cdp-client/factory.ts`              | Builds the ordered candidate list and returns a `ScopedCdpClient` with per-invocation failover. The macOS bridge is its internal `"host-bridge"` candidate kind.                                                                                                                                                                                                                                                                                                  |
| **BrowserSessionManager** | `browser-session/manager.ts`                       | Routes CDP commands through the selected backend with session tracking.                                                                                                                                                                                                                                                                                                                                                                                           |
| **CdpInspectClient**      | `tools/browser/cdp-client/cdp-inspect-client.ts`   | Connects to a host Chrome instance via its remote-debugging WebSocket endpoint.                                                                                                                                                                                                                                                                                                                                                                                   |
| **LocalCdpClient**        | `tools/browser/cdp-client/local-cdp-client.ts`     | Drives Playwright's CDPSession against the sacrificial-profile browser.                                                                                                                                                                                                                                                                                                                                                                                           |
| **ExtensionCdpClient**    | `tools/browser/cdp-client/extension-cdp-client.ts` | Routes CDP commands through the HostBrowserProxy to the user's real Chrome.                                                                                                                                                                                                                                                                                                                                                                                       |
| **Desktop-auto config**   | `config/schemas/host-browser.ts`                   | `desktopAuto.enabled` (default `true`) and `desktopAuto.cooldownMs` (default 30s) control automatic cdp-inspect on macOS.                                                                                                                                                                                                                                                                                                                                         |

Nothing in the turn layer wires the proxy: it reads the hub's live roster on every send, and a conversation's own event sink is fixed for its life (see `assistant/AGENTS.md`, "Conversation event delivery and turn presence"), so a queued or drained turn reaches the extension exactly like a live one.

## Transport Matrix

How `host_browser_request` frames reach a client, by originating interface and extension connectivity:

| Interface          | Extension Connected | Transport                 | Target                                  | Notes                                                                       |
| ------------------ | ------------------- | ------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `chrome-extension` | Yes (always)        | SSE (`assistantEventHub`) | The chrome-extension client             | The only transport for chrome-extension turns                               |
| `macos`            | Yes                 | SSE (`assistantEventHub`) | The chrome-extension client (preferred) | Browser tools route through the user's real Chrome session                  |
| `macos`            | No                  | SSE (`assistantEventHub`) | The macOS desktop client (bridge)       | Desktop client executes CDP locally against the user's Chrome               |
| Other              | Any                 | SSE (`assistantEventHub`) | Any connected `host_browser` client     | Falls through to cdp-inspect or local Playwright when no client is eligible |

## Wire Diagram

```
macOS app (user message)
    |
    v
POST /v1/messages  { interface: "macos", ... }
    |
    v
Agent loop invokes browser tool
    |
    v
getCdpClient(toolContext)
    |-- toolContext.hostBrowserProxy set?
    |       AND hostBrowserProxy.isAvailable()?
    |       --> candidate: extension (priority 1)
    |       [HostBrowserProxy publishes to the hub with
    |        targetCapability "host_browser"; the target client is
    |        the extension when one is connected, else the macOS bridge]
    |
    |-- transportInterface === "macos"
    |       AND desktopAuto.enabled?
    |       AND cooldown NOT active?
    |       --> candidate: cdp-inspect (priority 2)
    |
    |-- always --> candidate: local (priority 3)
    |
    v
ScopedCdpClient.send(method, params)
    |
    +-- Try candidate 1 (extension / macOS bridge)
    |       transport_error? --> failover to candidate 2
    |       cdp_error? --> propagate immediately (no failover)
    |       success? --> sticky for remainder of invocation
    |
    +-- Try candidate 2 (cdp-inspect)
    |       transport_error? --> record cooldown, failover to candidate 3
    |       success? --> sticky
    |
    +-- Try candidate 3 (local)
            last resort -- errors propagate
```

## Backend Precedence (macOS)

| Priority | Backend                      | When selected                                                                                                                                                                                                                        | Transport            | Failover trigger                                                                                                                   |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Extension / macOS host proxy | `extension` candidate when `hasExtensionClient(actor)` finds a chrome-extension client; otherwise `host-bridge` candidate when `isAvailable(actor)` finds a `host_browser` client and the actor's host-bridge cooldown is not active | SSE (hub)            | Transport error (client disconnected, no eligible client, publish failed). A `host-bridge` failure records the per-actor cooldown. |
| 2        | cdp-inspect                  | Config `enabled: true`, OR macOS + `desktopAuto.enabled` (default) + cooldown not active                                                                                                                                             | Direct CDP WebSocket | Transport error (endpoint unreachable, WS connect failure). Records cooldown on failure.                                           |
| 3        | Local (Playwright)           | Always present as final fallback                                                                                                                                                                                                     | In-process CDP       | Errors propagate to the tool                                                                                                       |

After the first successful CDP command on any backend, that backend becomes **sticky** for the remainder of the tool invocation.

## Host-bridge Cooldown

When the `host-bridge` candidate fails with a transport error, the factory records a per-actor cooldown (`recordHostBridgeCooldown`, keyed by `sourceActorPrincipalId`, `__default__` when unresolved) for the same `desktopAuto.cooldownMs` window. While it is active, `buildCandidateList` skips the bridge (log `CDP factory: host-bridge skipped (cooldown active)`) and the turn goes straight to cdp-inspect/local. Per-actor rather than process-global because on a multi-actor cloud daemon the bridge reaches a different desktop per actor. The `extension` candidate is never cooled down.

## Desktop-auto cdp-inspect Cooldown

When cdp-inspect fails with a transport error during a desktop-auto attempt:

1. The factory records `_desktopAutoCooldownSince = Date.now()`.
2. Subsequent `buildCandidateList()` calls skip cdp-inspect while `Date.now() - cooldownSince < cooldownMs`.
3. Default cooldown is 30 seconds (`desktopAuto.cooldownMs`).
4. Cooldown only applies to desktop-auto candidates (reason starts with `"desktopAuto:"`). Explicitly configured cdp-inspect is never suppressed.

## Manual QA Checklist

### Scenario 1: Extension Connected (macOS)

**Setup:**

1. Pair the browser extension (self-hosted: the extension pairs itself through `POST /v1/pair`; cloud: sign in through the platform).
2. Verify the extension's SSE subscription is registered (runtime log `subscriber registered (client)` with `interfaceId: "chrome-extension"` and `capabilities: ["host_browser"]`).

**Test:**

1. Send a message that triggers browser automation (e.g. "navigate to example.com and take a screenshot").
2. Observe the assistant drives the user's real Chrome session (visible browser activity in the user's Chrome, not a separate Playwright window).

**Expected telemetry/log signals:**

- `cdp-factory` log: `CDP factory: built candidate list` with `candidates: [{kind: "extension", ...}, {kind: "cdp-inspect", ...}, {kind: "local", ...}]`
- `cdp-factory` log: `CDP factory: candidate succeeded, backend is now sticky` with `candidateKind: "extension"`
- No `browserManager` launch log (Playwright not started).
- The extension's SSE stream receives `host_browser_request` frames; results arrive as `POST /v1/host-browser-result`.

### Scenario 1b: macOS Host Browser Proxy (No Extension)

**Setup:**

1. macOS desktop client is running and connected to the assistant via SSE.
2. No browser extension is installed or connected.
3. Chrome is running on the desktop machine.

**Test:**

1. Send a message that triggers browser automation (e.g. "navigate to example.com and take a screenshot").
2. Observe the assistant drives the user's Chrome session via the macOS host browser proxy (the desktop client receives `host_browser_request` frames over SSE and executes CDP commands locally).

**Expected telemetry/log signals:**

- `cdp-factory` log: `CDP factory: built candidate list` with `candidates: [{kind: "host-bridge", ...}, {kind: "cdp-inspect", ...}, {kind: "local", ...}]`
- `cdp-factory` log: `CDP factory: candidate succeeded, backend is now sticky` with `candidateKind: "host-bridge"`
- No `browserManager` launch log (Playwright not started).
- The macOS client's SSE stream delivers the `host_browser_request` frames.
- No failover: the bridge is the first candidate and succeeds.

**Difference from Scenario 1:** Same transport, different target: with no chrome-extension client on the hub roster, `resolveTargetClient` selects the macOS desktop client, which registers every host-proxy capability including `host_browser`.

### Scenario 2: Extension Absent + cdp-inspect Enabled

**Setup:**

1. No browser extension connected (or extension not installed).
2. Launch Chrome with `--remote-debugging-port=9222`.
3. Optionally set `hostBrowser.cdpInspect.enabled: true` in config (or rely on `desktopAuto.enabled: true` default for macOS).

**Test:**

1. Send a message that triggers browser automation.
2. Observe the assistant attaches to the existing Chrome via CDP (commands execute in the already-running Chrome, not a new Playwright window).

**Expected telemetry/log signals:**

- `cdp-factory` log: `CDP factory: built candidate list` with `candidates: [{kind: "cdp-inspect", ...}, {kind: "local", ...}]`
- `cdp-factory` log: `CDP factory: candidate succeeded, backend is now sticky` with `candidateKind: "cdp-inspect"`
- No `browserManager` launch log (Playwright not started).
- cdp-inspect discovery log: successful WebSocket connection to `ws://localhost:9222/...`.

### Scenario 3: Extension Absent + cdp-inspect Disabled/Unavailable

**Setup:**

1. No browser extension connected.
2. Chrome NOT launched with `--remote-debugging-port` (the common default).
3. `desktopAuto.enabled: true` (default).

**Test:**

1. Send a message that triggers browser automation.
2. Observe the assistant opens a Playwright-managed Chromium window (sacrificial profile).

**Expected telemetry/log signals:**

- `cdp-factory` log: `CDP factory: built candidate list` with `candidates: [{kind: "cdp-inspect", reason: "desktopAuto: ..."}, {kind: "local", ...}]`
- `cdp-factory` log: `CDP factory: transport-level failure, failing over to next candidate` with `candidateKind: "cdp-inspect"`
- `cdp-factory` log: `CDP factory: recording desktop-auto cdp-inspect cooldown after transport failure`
- `cdp-factory` log: `CDP factory: candidate succeeded, backend is now sticky` with `candidateKind: "local"`
- `browserManager` launch log visible (Playwright starting).
- Subsequent turns within 30 seconds: `cdp-factory` log shows `desktop-auto cdp-inspect skipped (cooldown active)` and candidates are `[{kind: "local"}]` only.

### Verifying Which Backend Executed

In all scenarios, the definitive signal is the `cdp-factory` structured log:

```
CDP factory: candidate succeeded, backend is now sticky
  candidateKind: "extension" | "host-bridge" | "cdp-inspect" | "local"
  conversationId: "<id>"
  method: "<first CDP method called>"
```

Filter runtime logs with:

```bash
grep -h "cdp-factory" "$VELLUM_WORKSPACE_DIR"/data/logs/assistant-*.log
```

## Steady-state contract

After the first successful Connect, the extension operates as a
background service with no further user interaction required:

1. **Install once**: Load the extension.
2. **Connect once**: Click Connect in the popup. The worker
   auto-bootstraps credentials (local pair token or cloud JWT) as part
   of the single-click flow.
3. **Forget it**: The extension keeps its SSE subscription up indefinitely.
   A `chrome.alarms` alarm (`vellum-relay-keepalive`, every 30 s) wakes the
   MV3 service worker and reconnects the stream if it is closed; transient
   drops reconnect with exponential backoff (`sse-connection.ts`). The
   `autoConnect` flag persists across browser sessions so reopening Chrome
   automatically reconnects. An authentication failure is not retried
   silently: it surfaces as the `auth_required` health state below.

Users should only interact with the extension again when:

- They want to **Pause** (intentionally disconnect and disable
  auto-reconnect).
- The popup shows **Action required** (`auth_required` or `error` health
  state), meaning automatic recovery has been exhausted.

A transient extension disconnect does change backend selection. In auto
mode `buildCandidateList` reads the hub roster at the start of each
browser operation: with no chrome-extension client connected it skips the
`extension` candidate and the chain proceeds to `host-bridge` (macOS),
cdp-inspect (opt-in, or desktop-auto on macOS), then local; and an
extension that drops mid-command surfaces a `transport_error`, which
advances the chained client to the next candidate. Only a dispatch pinned
with `browser_mode: "extension"` waits through the proxy's reconnect grace
(`EXTENSION_RECONNECT_GRACE_MS`, 3 s) before failing. `cdp-inspect` is an
advanced backend for users who cannot install the extension or who need
broad session-level CDP access; see
[the `cdp-inspect` backend doc](../../docs/browser-use-cdp-inspect-backend.md).

## Known UX considerations

### `chrome.debugger` infobar

When the Chrome extension calls
`chrome.debugger.attach(target, requiredVersion)`, Chrome displays a
persistent yellow infobar at the top of the affected tab saying "Vellum
started debugging this browser." This is an intentional security
mitigation; it cannot be suppressed via the public MV3 API.

Chrome API notes:

- `chrome.debugger.attach(target, requiredVersion, callback)`: three-
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

Decision: accept the infobar; no public API exists to suppress it. End-user messaging in the
Mac app popup should explain that the banner is expected and normal
when Vellum is driving the browser.

Alternatives considered:

- Playwright / `chrome --remote-debugging-port` in a sacrificial profile
  avoids the infobar but requires installing Chromium and is out-of-
  scope.
- The assistant-local `cdp-inspect` backend attaches to an existing
  Chrome instance via `chrome://inspect` / `--remote-debugging-port`
  and avoids the per-tab debugger infobar entirely. It is implemented
  and opt-in via `hostBrowser.cdpInspect.enabled`; see
  [the `cdp-inspect` backend doc](../../docs/browser-use-cdp-inspect-backend.md)
  for setup, security trade-offs, and troubleshooting. Note that in auto
  mode it is also the next candidate after `host-bridge` when the
  extension is disconnected at the start of an operation (see the
  steady-state contract above).
