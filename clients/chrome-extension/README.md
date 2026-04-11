# Vellum Chrome Extension — Local Development

This directory contains the MV3 Chrome extension used for browser relay.

Core pieces:
- `background/worker.ts`: service worker (relay lifecycle, pairing, CDP dispatch)
- `background/assistant-auth-profile.ts`: lockfile topology to auth profile mapping
- `background/native-host-assistants.ts`: native messaging client for assistant catalog
- `popup/`: popup UI (assistant selector, one-click Connect, Pause, troubleshooting auth controls)
- `popup/popup-state.ts`: pure view-state helpers for the assistant selector
- `native-host/`: native messaging helper (`com.vellum.daemon`) for self-hosted pairing and assistant discovery
- `build.sh`: bundles extension assets into `dist/`

## Prerequisites

- Bun installed and on `PATH`
- Chrome with Developer mode enabled (`chrome://extensions`)
- At least one running assistant (local or cloud-managed)

If you run commands from this repo, use:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

## Build And Load The Extension

```bash
cd clients/chrome-extension
bash build.sh
```

Then in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `clients/chrome-extension/dist`

## How It Works — Install Once, Connect Once, Forget It

The extension discovers available assistants from the lockfile via the native
messaging helper (`com.vellum.daemon`). The lockfile lists every assistant
configured on the machine, along with its hosting topology (`cloud` field),
runtime URL, and local assistant port.

After the first successful Connect, the extension maintains a long-lived
background connection and recovers automatically from transient interruptions
(browser restarts, network drops, service-worker suspension, token rotation).
Users should **not** need to touch Pair, Sign-in, or Connect again under
normal operation.

### First-Time Connect (One Click)

1. The user opens the popup and clicks **Connect**.
2. The worker resolves the selected assistant's auth profile from the
   lockfile topology, then auto-bootstraps credentials under the hood:
   - **Local assistants** (`local-pair`): The worker spawns the native
     messaging helper, which POSTs to the assistant's
     `/v1/browser-extension-pair` endpoint and returns a scoped capability
     token. No manual "Pair" step is needed.
   - **Cloud assistants** (`cloud-oauth`): The worker launches a
     `chrome.identity.launchWebAuthFlow` against the cloud gateway to
     obtain an OAuth token. No manual "Sign in" step is needed.
3. Once credentials are obtained, the relay WebSocket opens automatically.

The entire flow is a single user action — click **Connect**.

### Long-Lived Background Behavior

After a successful first connect, the extension runs as a long-lived
background service. The relay WebSocket stays open and the service worker
sends periodic keepalive frames (every 20 seconds) to prevent Chrome's
MV3 idle-suspension timeout (~30 seconds). The assistant runtime
acknowledges keepalives by touching the connection's activity timestamp
in the `ChromeExtensionRegistry`.

The extension handles the following interruptions automatically:

| Interruption | Recovery |
|---|---|
| **Service-worker restart** (Chrome MV3 teardown/relaunch) | Auto-reconnect via persisted `autoConnect` flag and stored credentials. |
| **Transient network drop** (cable unplugged, Wi-Fi blip) | Exponential-backoff reconnect (1 s base, 30 s cap). |
| **Token expiry** (local capability token or cloud JWT) | Silent non-interactive token refresh via native messaging (local) or OAuth refresh (cloud) before the next reconnect attempt. |
| **Assistant restart** | WebSocket close triggers reconnect; the extension re-establishes the relay against the new runtime instance. |
| **Browser close and reopen** | The `autoConnect` flag persists across browser sessions, so the worker auto-connects on startup. |

Users should **not** re-pair, re-sign-in, or re-click Connect for any of
these cases. The popup's health indicator shows the current state
(`Connected`, `Reconnecting automatically...`, `Paused`, or
`Action required`) so users can verify recovery is happening without
taking action.

### When User Action IS Required

The extension enters `auth_required` only when non-interactive token
refresh is impossible (e.g. the cloud OAuth refresh token itself has
expired, or the native messaging host is uninstalled). In this state the
popup's Troubleshooting section expands automatically and prompts the
user to re-pair (local) or re-sign-in (cloud), then click **Connect**.

### Auto-Connect On Reopen

After a successful first connect, the extension sets a persistent
`autoConnect` flag. On subsequent browser launches (or service-worker
restarts), the worker reads this flag and automatically reconnects using
the stored credentials — no user interaction required.

If stored credentials have expired or are missing at auto-connect time
and silent refresh also fails, the extension transitions to
`auth_required`. The user can click **Connect** to re-bootstrap
credentials interactively.

### Pause Semantics

**Pause** is the user-facing stop action. It:
- Tears down the active relay WebSocket.
- Clears the `autoConnect` flag so the extension does **not** reconnect
  on the next browser launch.
- Preserves stored credentials so the next **Connect** is instant (no
  re-pair or re-sign-in needed unless the token has expired).

Pause replaces the previous "Disconnect" terminology. It is the only
action that intentionally stops the extension — all other disconnects
trigger automatic recovery.

### Assistant Discovery And Selection

1. On popup open, the worker sends a `list_assistants` request to the native
   messaging helper, which reads the lockfile and returns the assistant catalog.
2. The worker resolves a selected assistant using these rules:
   - **Single assistant**: auto-selected; no dropdown shown.
   - **Multiple assistants**: dropdown shown in lockfile order. The previously
     stored selection is reused if still present in the catalog; otherwise the
     first entry is selected by default.
   - **No assistants (empty lockfile)**: empty state shown.
3. Switching assistants in the dropdown persists the new selection and
   reconnects the relay to the newly selected assistant's endpoint.

### Topology-To-Auth Mapping

Each assistant's `cloud` field in the lockfile determines which auth flow
the worker bootstraps automatically on Connect. The mapping is in
`assistant-auth-profile.ts`:

| `cloud` value | Auth profile | Auth bootstrapped on Connect |
|---|---|---|
| `local` | `local-pair` | Native messaging pair (capability token) |
| `apple-container` | `local-pair` | Native messaging pair (capability token) |
| `vellum` | `cloud-oauth` | Chrome identity OAuth flow |
| `platform` | `cloud-oauth` | Chrome identity OAuth flow |
| *(anything else)* | `unsupported` | Error: update the extension |

- **`local-pair`**: The worker auto-pairs via native messaging on Connect.
  The relay targets the local assistant at
  `ws://127.0.0.1:<port>/v1/browser-relay`.

- **`cloud-oauth`**: The worker auto-signs in via Chrome identity on Connect.
  The relay targets the cloud gateway at
  `wss://<runtimeUrl>/v1/browser-relay`.

- **`unsupported`**: An error message instructs the user to update the
  extension. No auth panel is shown.

Auth tokens are stored per-assistant under scoped storage keys so
switching between assistants does not require re-authentication.

### Manual Recovery (Troubleshooting)

The popup includes a collapsible **Troubleshooting** section with manual
"Re-pair with local assistant" and "Re-sign in with Vellum (cloud)"
buttons. These are **not** required for the normal connect flow — they
exist for edge cases where automatic recovery is impossible.

**When to use Troubleshooting controls:**
- The popup shows `Action required` with an `auth_required` health state.
- The Troubleshooting section expanded automatically (it stays collapsed
  during `connected`, `reconnecting`, `connecting`, and `paused` states).

**When NOT to use Troubleshooting controls:**
- The popup shows `Reconnecting automatically...` — the extension is
  already recovering and will reconnect on its own.
- The popup shows `Connected` — everything is working.
- The popup shows `Paused` — click **Connect** (not Troubleshoot) to
  resume.

Transient disconnects (network drops, service-worker restarts, assistant
restarts) are handled silently with exponential-backoff reconnect and
automatic token refresh. Touching the Troubleshooting controls during a
transient interruption is unnecessary and may interfere with the
automatic recovery path.

### Connection Health States

The worker maintains a structured health state machine surfaced to the
popup via `get_status`. The six states drive the popup's status indicator,
button enablement, and Troubleshooting section visibility:

| State | Popup display | Auto-reconnect? | User action needed? |
|---|---|---|---|
| `connected` | Green dot, "Connected" | n/a | No |
| `connecting` | Gray dot, "Connecting..." | n/a | No |
| `reconnecting` | Yellow dot, "Reconnecting automatically..." | Yes | No |
| `paused` | Yellow dot, "Paused" | No | Click Connect to resume |
| `auth_required` | Gray dot, "Action required: ..." | No | Re-pair / Re-sign-in, then Connect |
| `error` | Gray dot, "Error: ..." | No | Check Troubleshooting section |

The `reconnecting` state means the extension detected an unexpected
disconnect and is actively recovering — the user should wait. Only
`auth_required` and `error` warrant manual intervention.

## End-to-End Validation (QA Playbook)

Use this checklist to verify the "install once, connect once, forget it"
contract from a clean state.

### Setup
1. Build and load the extension (see [Build And Load](#build-and-load-the-extension)).
2. Start at least one local assistant (or have a cloud-managed assistant configured).
3. Verify the native messaging host is installed (macOS app installs it automatically).

### Happy path
1. Open the extension popup.
2. Click **Connect**. Verify the status transitions: `Connecting...` then `Connected`.
3. Close Chrome completely. Reopen Chrome.
4. Open the extension popup. Verify the status shows `Connected` (auto-reconnect from `autoConnect` flag).
5. Open the service worker console (`chrome://extensions` > Service worker link). Verify keepalive frames are logged every ~20 seconds.

### Automatic recovery — network drop
1. While connected, disable your network adapter (Wi-Fi off, cable out).
2. Open the popup. Verify the status shows `Reconnecting automatically...`.
3. Re-enable the network adapter.
4. Verify the status returns to `Connected` within ~30 seconds (backoff cap).

### Automatic recovery — assistant restart
1. While connected, stop the assistant process.
2. Verify the popup shows `Reconnecting automatically...`.
3. Restart the assistant.
4. Verify the popup returns to `Connected`.

### Automatic recovery — token refresh
1. While connected, manually expire or delete the stored token in `chrome.storage.local`.
2. On the next reconnect cycle, the extension should silently re-bootstrap the token (local pair via native messaging, or cloud via OAuth refresh).
3. Verify the popup returns to `Connected` without manual intervention.

### Pause and resume
1. While connected, click **Pause**. Verify the status shows `Paused`.
2. Close and reopen Chrome. Verify the popup still shows `Paused` (autoConnect cleared).
3. Click **Connect**. Verify the status returns to `Connected`.

### Auth failure (manual recovery required)
1. Uninstall the native messaging host (or revoke the cloud OAuth token entirely).
2. Force a reconnect (restart Chrome or stop/start the assistant).
3. Verify the popup shows `Action required` and the Troubleshooting section expands automatically.
4. Reinstall the native host (or re-sign-in), then click **Connect**. Verify recovery.

## Native Messaging Host Setup (If Pairing Fails)

Preferred path: launch the macOS app once; it installs the native messaging manifest automatically.

Manual fallback (dev only):

1. Build the helper:

```bash
cd clients/chrome-extension/native-host
bun install
bun run build
chmod +x dist/index.js
```

2. Find your extension ID in `chrome://extensions`.
3. Add that ID to:
   - `meta/browser-extension/chrome-extension-allowlist.json`
4. Install Chrome native messaging manifest:

```bash
mkdir -p "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH"
  exit 1
fi
cat > "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon.sh" <<'BASH'
#!/bin/bash
exec "__NODE_BIN__" "/ABSOLUTE/PATH/TO/clients/chrome-extension/native-host/dist/index.js" "$@"
BASH
sed -i '' "s|__NODE_BIN__|$NODE_BIN|g" "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon.sh"
chmod 755 "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon.sh"

cat > "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon.json" <<'JSON'
{
  "name": "com.vellum.daemon",
  "description": "Vellum assistant native messaging host",
  "path": "/Users/<you>/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
JSON
chmod 644 "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon.json"
```

Note: prefer a wrapper script with an absolute Node path (above). Chrome launches
native hosts with a minimal environment, so `#!/usr/bin/env node` often fails even
when `node` works in your terminal.

5. Fully quit and relaunch Chrome.

## Dev Loop

After editing extension code:

```bash
cd clients/chrome-extension
bash build.sh
```

Then in `chrome://extensions`, click **Reload** on the unpacked extension.

## Debugging

- Service worker logs:
  - `chrome://extensions` → extension card → **Service worker** link
- Popup logs:
  - Open popup → right-click → **Inspect**

## Troubleshooting

### Empty lockfile / no assistants shown

The native messaging helper reads the lockfile to discover assistants. If the
popup shows no assistants:

- Verify at least one assistant is running: check for the lockfile at
  `~/.vellum.lock.json` (or `~/.vellum.lockfile.json` for legacy installs).
- Verify the native messaging host is installed and reachable (see the setup
  section above). The macOS app installs the manifest automatically on launch.
- Check the service worker console for `native messaging` errors.

### Unsupported topology

If the popup shows "This assistant uses an unsupported topology", the
assistant's `cloud` field in the lockfile is not recognized by this version
of the extension. Update the extension to the latest version.

### Per-assistant auth mismatch

Each assistant requires its own auth token scoped to its topology. The
worker auto-bootstraps the correct token type on Connect, so switching
between assistants with different topologies is handled transparently.

If automatic bootstrap fails, use the Troubleshooting controls:
- A `local` assistant can be manually re-paired via "Re-pair with local
  assistant".
- A `vellum`/`platform` assistant can be manually re-signed-in via
  "Re-sign in with Vellum (cloud)".

### Common error messages

- `Access to the specified native messaging host is forbidden`
  - Manifest missing/invalid, `allowed_origins` mismatch, or extension ID not allowlisted in `meta/browser-extension/chrome-extension-allowlist.json`
- `Native host has exited`
  - Chrome could not launch Node for a `dist/index.js` host path. Use a wrapper script with an absolute Node path in the manifest `path`.
- `assistant pair request failed with HTTP 401`
  - The pair endpoint rejected `extensionOrigin`. Verify your extension ID is in `meta/browser-extension/chrome-extension-allowlist.json`, then restart the assistant so it reloads allowlist config.
- `Automatic cloud sign-in failed — use 'Re-sign in' in Troubleshooting, then try Connect again`
  - The selected assistant uses cloud-oauth and the automatic sign-in failed. Use the "Re-sign in" button in the Troubleshooting section of the popup, then click Connect again.
- `Automatic local pairing failed — use 'Re-pair' in Troubleshooting, then try Connect again`
  - The selected assistant uses local-pair and the automatic pairing failed. Use the "Re-pair" button in the Troubleshooting section of the popup, then click Connect again.
- `Select an assistant before connecting`
  - No assistant is selected. The lockfile may be empty or the native messaging helper is unreachable.
- `failed to reach assistant at http://127.0.0.1:<port>/v1/browser-extension-pair`
  - Assistant not running, wrong runtime port, or local firewall/network policy

### Useful checks

```bash
cat ~/.vellum.lock.json
cat ~/.vellum/runtime-port
cat "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon.json"
cat meta/browser-extension/chrome-extension-allowlist.json
```

## Tests

Extension:

```bash
cd clients/chrome-extension
bunx tsc --noEmit
bun test background/__tests__/self-hosted-auth.test.ts
bun test background/__tests__/worker-selected-assistant-connect.test.ts
bun test background/__tests__/relay-connection.test.ts
```

Native host helper:

```bash
cd clients/chrome-extension/native-host
bunx tsc --noEmit
bun test src/
```

For deeper helper details, see:
- `clients/chrome-extension/native-host/README.md`
