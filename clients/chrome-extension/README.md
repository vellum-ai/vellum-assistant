# Vellum Chrome Extension — Local Development

This directory contains the MV3 Chrome extension used for browser relay.

Core pieces:
- `background/worker.ts`: service worker (relay lifecycle, pairing, CDP dispatch)
- `background/assistant-auth-profile.ts`: lockfile topology to auth profile mapping
- `background/native-host-assistants.ts`: native messaging client for assistant catalog
- `popup/`: popup UI (assistant selector, auth panels, Connect/Disconnect)
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

## How It Works — Assistant-Centric Model

The extension discovers available assistants from the lockfile via the native
messaging helper (`com.vellum.daemon`). The lockfile lists every assistant
configured on the machine, along with its hosting topology (`cloud` field),
runtime URL, and daemon port.

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
the extension uses. The mapping is in `assistant-auth-profile.ts`:

| `cloud` value | Auth profile | Auth flow |
|---|---|---|
| `local` | `local-pair` | Native messaging pair (capability token) |
| `apple-container` | `local-pair` | Native messaging pair (capability token) |
| `vellum` | `cloud-oauth` | Chrome identity OAuth flow |
| `platform` | `cloud-oauth` | Chrome identity OAuth flow |
| *(anything else)* | `unsupported` | Error: update the extension |

- **`local-pair`**: The popup shows the **Local** auth section with a
  "Pair with local assistant" button. Pairing spawns the native messaging
  helper, which POSTs to the assistant's `/v1/browser-extension-pair`
  endpoint and returns a scoped capability token. Connect targets the
  local assistant at `ws://127.0.0.1:<port>/v1/browser-relay`.

- **`cloud-oauth`**: The popup shows the **Cloud** auth section with a
  "Sign in with Vellum (cloud)" button. Sign-in runs a
  `chrome.identity.launchWebAuthFlow` against the cloud gateway. Connect
  targets the cloud gateway at `wss://<runtimeUrl>/v1/browser-relay`.

- **`unsupported`**: An error message instructs the user to update the
  extension. No auth panel is shown.

Auth tokens are stored per-assistant under scoped storage keys so
switching between assistants does not require re-authentication.

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
  `~/.vellum/lockfile.json` (or the path appropriate for your OS).
- Verify the native messaging host is installed and reachable (see the setup
  section above). The macOS app installs the manifest automatically on launch.
- Check the service worker console for `native messaging` errors.

### Unsupported topology

If the popup shows "This assistant uses an unsupported topology", the
assistant's `cloud` field in the lockfile is not recognized by this version
of the extension. Update the extension to the latest version.

### Per-assistant auth mismatch

Each assistant requires its own auth token scoped to its topology:

- A `local` assistant requires a **local pair** token (click "Pair with
  local assistant").
- A `vellum`/`platform` assistant requires a **cloud sign-in** token
  (click "Sign in with Vellum (cloud)").

Switching between assistants with different topologies may require completing
the appropriate auth flow for the newly selected assistant before connecting.

### Common error messages

- `Access to the specified native messaging host is forbidden`
  - Manifest missing/invalid, `allowed_origins` mismatch, or extension ID not allowlisted in `meta/browser-extension/chrome-extension-allowlist.json`
- `Native host has exited`
  - Chrome could not launch Node for a `dist/index.js` host path. Use a wrapper script with an absolute Node path in the manifest `path`.
- `assistant pair request failed with HTTP 401`
  - The pair endpoint rejected `extensionOrigin`. Verify your extension ID is in `meta/browser-extension/chrome-extension-allowlist.json`, then restart the assistant so it reloads allowlist config.
- `Sign in with Vellum (cloud) before connecting`
  - The selected assistant uses cloud-oauth but no cloud token is stored. Click "Sign in with Vellum (cloud)" first.
- `Pair the Vellum assistant (self-hosted) before connecting`
  - The selected assistant uses local-pair but no capability token is stored. Click "Pair with local assistant" first.
- `Select an assistant before connecting`
  - No assistant is selected. The lockfile may be empty or the native messaging helper is unreachable.
- `failed to reach assistant at http://127.0.0.1:<port>/v1/browser-extension-pair`
  - Assistant not running, wrong runtime port, or local firewall/network policy

### Useful checks

```bash
cat ~/.vellum/lockfile.json
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
