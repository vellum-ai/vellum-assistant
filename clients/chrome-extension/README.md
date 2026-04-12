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

2. Find your extension ID in `chrome://extensions`.
3. Add that ID to `meta/browser-extension/chrome-extension-allowlist.json`.
4. Install the Chrome native messaging manifest:

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
| `Access to the specified native messaging host is forbidden` | Manifest missing/invalid, or extension ID not in `meta/browser-extension/chrome-extension-allowlist.json` |
| `Native host has exited` | Chrome couldn't launch Node. Use a wrapper script with an absolute Node path in the manifest. |
| `assistant pair request failed with HTTP 401` | Extension ID not in allowlist. Add it to `meta/browser-extension/chrome-extension-allowlist.json` and restart the assistant. |
| `failed to reach assistant at http://127.0.0.1:<port>/...` | Assistant not running, wrong port, or firewall blocking. |
| `Automatic cloud sign-in failed` | Use "Re-sign in" in the popup's Troubleshooting section, then click Connect. |
| `Automatic local pairing failed` | Use "Re-pair" in the popup's Troubleshooting section, then click Connect. |

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
