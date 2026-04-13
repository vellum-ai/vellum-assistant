# Browser Use Architecture — Phase 2

## Overview

Phase 2 of browser automation introduced a three-tier backend selection chain for macOS-originated turns, enabling the assistant to prefer the user's real Chrome session (via the paired extension) over a sandboxed Playwright instance. When the extension is unavailable, the system falls back through cdp-inspect (direct Chrome DevTools Protocol attach) before resorting to the local Playwright browser.

This document describes the runtime architecture, backend precedence rules, and the manual QA playbook for verifying correct backend selection.

## Component Inventory

| Component                   | Location                                           | Role                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ChromeExtensionRegistry** | `runtime/chrome-extension-registry.ts`             | Tracks active extension WebSocket connections keyed by `(guardianId, clientInstanceId)`. Populated on WS `open`, drained on WS `close`.                                                |
| **HostBrowserProxy**        | `daemon/host-browser-proxy.ts`                     | Per-conversation proxy that dispatches `host_browser_request` frames and awaits `host_browser_result` responses.                                                                       |
| **CDP Factory**             | `tools/browser/cdp-client/factory.ts`              | Builds the ordered candidate list and returns a `ScopedCdpClient` with per-invocation failover.                                                                                        |
| **BrowserSessionManager**   | `browser-session/manager.ts`                       | Routes CDP commands through the selected backend with session tracking.                                                                                                                |
| **CdpInspectClient**        | `tools/browser/cdp-client/cdp-inspect-client.ts`   | Connects to a host Chrome instance via its remote-debugging WebSocket endpoint.                                                                                                        |
| **LocalCdpClient**          | `tools/browser/cdp-client/local-cdp-client.ts`     | Drives Playwright's CDPSession against the sacrificial-profile browser.                                                                                                                |
| **ExtensionCdpClient**      | `tools/browser/cdp-client/extension-cdp-client.ts` | Routes CDP commands through the HostBrowserProxy to the user's real Chrome.                                                                                                            |
| **conversation-routes.ts**  | `runtime/routes/conversation-routes.ts`            | Wires `resolveHostBrowserSender()` to set `hostBrowserSenderOverride` when the extension is connected. Sets `turnInterfaceContext` from the `interface` field on the incoming message. |
| **Desktop-auto config**     | `config/schemas/host-browser.ts`                   | `desktopAuto.enabled` (default `true`) and `desktopAuto.cooldownMs` (default 30s) control automatic cdp-inspect on macOS.                                                              |

## Wire Diagram

```
macOS app (user message)
    |
    v
POST /v1/messages  { interface: "macos", ... }
    |
    v
conversation-routes.ts
    |-- setTurnInterfaceContext({ userMessageInterface: "macos", ... })
    |-- resolveHostBrowserSender()
    |       |
    |       +-- ChromeExtensionRegistry.get(guardianId)
    |               |
    |               +-- entry found? --> registrySender (WS to extension)
    |               |                    hostBrowserSenderOverride = registrySender
    |               |                    provision HostBrowserProxy
    |               |
    |               +-- entry not found? --> SSE hub sender (default)
    |                                        hostBrowserSenderOverride = undefined
    |
    v
Agent loop invokes browser tool
    |
    v
getCdpClient(toolContext)
    |-- toolContext.hostBrowserProxy set?
    |       AND hostBrowserProxy.isAvailable()?
    |       --> candidate: extension (priority 1)
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
    +-- Try candidate 1 (extension)
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

| Priority | Backend            | When selected                                                                            | Failover trigger                                                                         |
| -------- | ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1        | Extension          | `hostBrowserProxy` present and `isAvailable()` is `true`                                 | Transport error (WebSocket disconnected, send failed)                                    |
| 2        | cdp-inspect        | Config `enabled: true`, OR macOS + `desktopAuto.enabled` (default) + cooldown not active | Transport error (endpoint unreachable, WS connect failure). Records cooldown on failure. |
| 3        | Local (Playwright) | Always present as final fallback                                                         | Errors propagate to the tool                                                             |

After the first successful CDP command on any backend, that backend becomes **sticky** for the remainder of the tool invocation.

## Desktop-auto cdp-inspect Cooldown

When cdp-inspect fails with a transport error during a desktop-auto attempt:

1. The factory records `_desktopAutoCooldownSince = Date.now()`.
2. Subsequent `buildCandidateList()` calls skip cdp-inspect while `Date.now() - cooldownSince < cooldownMs`.
3. Default cooldown is 30 seconds (`desktopAuto.cooldownMs`).
4. Cooldown only applies to desktop-auto candidates (reason starts with `"desktopAuto:"`). Explicitly configured cdp-inspect is never suppressed.

## Manual QA Checklist

### Scenario 1: Extension Connected (macOS)

**Setup:**

1. Pair the browser extension (chrome extension installed, `assistant pair browser-extension` completed or cloud pairing via platform).
2. Open the macOS app and verify the extension WebSocket is connected (check runtime logs for `browser-relay: registered connection`).

**Test:**

1. Send a message that triggers browser automation (e.g. "navigate to example.com and take a screenshot").
2. Observe the assistant drives the user's real Chrome session (visible browser activity in the user's Chrome, not a separate Playwright window).

**Expected telemetry/log signals:**

- `cdp-factory` log: `CDP factory: built candidate list` with `candidates: [{kind: "extension", ...}, {kind: "cdp-inspect", ...}, {kind: "local", ...}]`
- `cdp-factory` log: `CDP factory: candidate succeeded, backend is now sticky` with `candidateKind: "extension"`
- No `browserManager` launch log (Playwright not started).
- Extension WebSocket receives `host_browser_request` frames.

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
  candidateKind: "extension" | "cdp-inspect" | "local"
  conversationId: "<id>"
  method: "<first CDP method called>"
```

Filter runtime logs with:

```bash
grep "cdp-factory" ~/.vellum/workspace/data/logs/vellum.log
```
