# Vellum Chrome Extension

MV3 Chrome extension that connects your browser to a running Vellum assistant via a WebSocket relay. It discovers assistants from the local lockfile, handles auth automatically, and maintains a persistent background connection.

## Prerequisites

- Bun installed and on `PATH`
- Chrome with Developer mode enabled (`chrome://extensions`)
- At least one running assistant (local or cloud-managed)

If Bun isn't on your PATH:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

## Build & Load

```bash
cd clients/chrome-extension
bash build.sh
```

Then in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `clients/chrome-extension/dist`

## Dev Loop

After editing extension code:

```bash
cd clients/chrome-extension
bash build.sh
```

Then in `chrome://extensions`, click **Reload** on the unpacked extension.

## Publishing to Chrome Web Store

To create a zip for manual upload to the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole):

```bash
cd clients/chrome-extension
bash build.sh
cd dist && zip -r ../vellum-browser-relay.zip .
```

Upload `vellum-browser-relay.zip` through the dashboard.

For automated publishing, the `release.yml` GitHub Actions workflow builds, packages, and uploads to CWS when a release tag is created.

## Usage

1. Open the extension popup.
2. Select an assistant (if more than one is available).
3. Click **Connect**.

That's it. The extension auto-reconnects on browser restarts, network drops, and assistant restarts. Click **Pause** to intentionally stop the relay.

## Debugging

- **Service worker logs:** `chrome://extensions` > extension card > **Service worker** link
- **Popup logs:** Open popup > right-click > **Inspect**

## Native Messaging Host Setup

The macOS app installs the native messaging host automatically. If pairing fails, set it up manually:

1. Build the helper:

```bash
cd clients/chrome-extension/native-host
bun install
bun run build
chmod +x dist/index.js
```

2. Find your extension ID in `chrome://extensions` and export it. Chrome assigns this ID the first time you **Load unpacked**, so the snippet below needs it as an env var:

```bash
export EXTENSION_ID=<id from chrome://extensions>
```

3. Register the ID locally so the assistant accepts pair requests from your unpacked build. Create `~/.vellum/chrome-extension-allowlist.local.json` — this file is merged with the committed allowlist at assistant startup and stays local to your machine:

```bash
mkdir -p "$HOME/.vellum"
cat > "$HOME/.vellum/chrome-extension-allowlist.local.json" <<JSON
{
  "version": 1,
  "allowedExtensionIds": ["$EXTENSION_ID"]
}
JSON
```

Restart the assistant after creating or editing this file — the allowlist is cached at startup. The IDs are public Chrome extension identifiers, so no special file permissions are needed.

4. Install the Chrome native messaging manifest. **Run this from the same `native-host/` directory as step 1** — the snippet reads `$(pwd)/dist/index.js`:

```bash
NATIVE_HOST_JS="$(pwd)/dist/index.js"
NODE_BIN="$(command -v node)"
NATIVE_HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH" >&2; exit 1; fi
if [ -z "$EXTENSION_ID" ]; then echo "Set EXTENSION_ID=<id from chrome://extensions> first" >&2; exit 1; fi

mkdir -p "$NATIVE_HOSTS_DIR"

cat > "$NATIVE_HOSTS_DIR/com.vellum.daemon.sh" <<BASH
#!/bin/bash
exec "$NODE_BIN" "$NATIVE_HOST_JS" "\$@"
BASH
chmod 755 "$NATIVE_HOSTS_DIR/com.vellum.daemon.sh"

cat > "$NATIVE_HOSTS_DIR/com.vellum.daemon.json" <<JSON
{
  "name": "com.vellum.daemon",
  "description": "Vellum assistant native messaging host",
  "path": "$NATIVE_HOSTS_DIR/com.vellum.daemon.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
chmod 644 "$NATIVE_HOSTS_DIR/com.vellum.daemon.json"
```

> Chrome launches native hosts with a minimal environment, so `#!/usr/bin/env node` often fails. Use a wrapper script with an absolute Node path instead.

5. Fully quit and relaunch Chrome.

## Troubleshooting

### No assistants shown in popup

- Verify an assistant is running: check `~/.vellum.lock.json`
- Verify the native messaging host is installed (see above)
- Check the service worker console for `native messaging` errors

### Common error messages

| Error | Cause / Fix |
|---|---|
| `Access to the specified native messaging host is forbidden` | Manifest missing/invalid, or extension ID not in the allowlist. Add it to `~/.vellum/chrome-extension-allowlist.local.json` (see Native Messaging Host Setup, step 3). |
| `Native host has exited` | Chrome couldn't launch Node. Use a wrapper script with an absolute Node path in the manifest. |
| `assistant pair request failed with HTTP 401` | Extension ID not in allowlist. Add it to `~/.vellum/chrome-extension-allowlist.local.json` and restart the assistant (the allowlist is cached at assistant startup). |
| `failed to reach assistant at http://127.0.0.1:<port>/...` | Assistant not running, wrong port, or firewall blocking. |
| `Automatic cloud sign-in failed` | Use "Re-sign in" in the popup's Troubleshooting section, then click Connect. |
| `Automatic local pairing failed` | Use "Re-pair" in the popup's Troubleshooting section, then click Connect. |

### Non-default Chrome profile (`--user-data-dir`)

If Chrome is launched with a non-default `--user-data-dir` (common for debugging profiles or Chrome-in-Chrome setups), the native messaging host manifest must also be installed under that profile, not only at the default `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. Chrome searches its active user-data-dir as well, and the default-path fallback is unreliable for non-default profiles.

Check which profile Chrome is using:

```bash
ps aux | grep "Google Chrome" | grep -- --user-data-dir
```

If the flag is present, copy the manifest and wrapper into `<user-data-dir>/NativeMessagingHosts/`:

```bash
USER_DATA_DIR="<path from ps output>"
mkdir -p "$USER_DATA_DIR/NativeMessagingHosts"
cp "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vellum.daemon."* \
  "$USER_DATA_DIR/NativeMessagingHosts/"
```

Then fully quit and relaunch Chrome.

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

See `clients/chrome-extension/native-host/README.md` for more on the native host.
