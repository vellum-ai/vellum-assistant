# Vellum Chrome Extension — Local Development

This directory contains the MV3 Chrome extension used for browser relay.

Core pieces:
- `background/worker.ts`: service worker (relay lifecycle, pairing, CDP dispatch)
- `popup/`: popup UI (`Pair with local assistant`, `Connect`, cloud sign-in)
- `native-host/`: native messaging helper (`com.vellum.daemon`) used for self-hosted pairing
- `build.sh`: bundles extension assets into `dist/`

## Prerequisites

- Bun installed and on `PATH`
- Chrome with Developer mode enabled (`chrome://extensions`)
- A local assistant running (for self-hosted mode)

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

## Self-hosted (Local Assistant) Flow

1. Start your local assistant.
2. Click the extension icon to open the popup.
3. Keep mode on **Self-hosted**.
4. Click **Pair with local assistant**.
5. Click **Connect**.

If pairing succeeds, `Local` will show a paired guardian and expiry.

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

## Cloud Flow (Optional)

1. In popup, switch mode to **Cloud**
2. Click **Sign in with Vellum (cloud)**
3. Click **Connect**

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

Common failures:
- `Access to the specified native messaging host is forbidden`
  - Manifest missing/invalid, `allowed_origins` mismatch, or extension ID not allowlisted in `meta/browser-extension/chrome-extension-allowlist.json`
- `Native host has exited`
  - Chrome could not launch Node for a `dist/index.js` host path. Use a wrapper script with an absolute Node path in the manifest `path`.
- `assistant pair request failed with HTTP 401`
  - The pair endpoint rejected `extensionOrigin`. Verify your extension ID is in `meta/browser-extension/chrome-extension-allowlist.json`, then restart the assistant so it reloads allowlist config.
- `Self-hosted relay is not paired yet`
  - Click **Pair with local assistant** first
- `failed to reach assistant at http://127.0.0.1:<port>/v1/browser-extension-pair`
  - Assistant not running, wrong runtime port, or local firewall/network policy

Useful checks:

```bash
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
```

Native host helper:

```bash
cd clients/chrome-extension/native-host
bunx tsc --noEmit
bun test src/
```

For deeper helper details, see:
- `clients/chrome-extension/native-host/README.md`
