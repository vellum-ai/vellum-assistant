# Vellum Assistant Chrome Extension

MV3 Chrome extension that connects your browser to a running Vellum assistant via a WebSocket relay. It discovers assistants from the local lockfile, handles auth automatically, and maintains a persistent background connection.

## Install from Chrome Web Store

Install the [Vellum Assistant](https://chromewebstore.google.com/detail/vellum-assistant-browser/hphbdmpffeigpcdjkckleobjmhhokpne) extension directly from the Chrome Web Store. This is the recommended approach for most users — no developer mode required.

## Development

### Prerequisites

- Bun installed and on `PATH`
- Chrome with Developer mode enabled (`chrome://extensions`)
- At least one running assistant (local or cloud-managed)

If Bun isn't on your PATH:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

### Build & Load

```bash
cd clients/chrome-extension
bash build.sh
```

Then in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `clients/chrome-extension/dist`

### Dev Loop

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

## Environment Selector

The popup's **Advanced** section includes an **Environment** dropdown that lets you switch between `local`, `dev`, `staging`, and `production` without rebuilding the extension. This controls which cloud API and web URLs are used for sign-in, pairing, and relay connections.

### Precedence rules

The effective environment is resolved in this order:

| Priority | Source | Description |
|---|---|---|
| 1 (highest) | Popup override | Selected in the dropdown, persisted in `chrome.storage.local` |
| 2 | Build-time default | Injected via `--define process.env.VELLUM_ENVIRONMENT=...` at bundle time |
| 3 (fallback) | Hard-coded default | `dev` |

### Expected defaults by context

| Context | Build default | Notes |
|---|---|---|
| Local dev build (`bash build.sh`) | `dev` | No `--define` injection; falls back to `dev` |
| `vel up` (local assistant) | `dev` build / `local` override | Build defaults to `dev`; use the popup dropdown to select `local` to target `localhost` endpoints |
| Staging release artifact | `staging` | Set by `release.yml` via `--define` |
| Production release artifact (CWS) | `production` | Set by `release.yml` via `--define` |

### Behavior on change

When you change the environment in the dropdown:

1. The override is persisted immediately (survives popup close/reopen).
2. The assistant catalog is refreshed (different environments may list different assistants).
3. Local and cloud auth status panels are refreshed.
4. If the extension is currently connected, it automatically disconnects and reconnects using the new environment's endpoints.

To clear the override and revert to the build default, the dropdown simply selects the build-default value (no separate "reset" action needed since the worker treats selecting the same value as the build default equivalently).

## Debugging

- **Service worker logs:** `chrome://extensions` > extension card > **Service worker** link
- **Popup logs:** Open popup > right-click > **Inspect**

## Extension ID & Allowlisting

Chrome assigns each extension a unique 32-character ID. The assistant needs to know your extension's ID so it can accept connections from it. Three sources are merged at startup (duplicates are deduplicated):

| Source | Purpose |
|---|---|
| `meta/browser-extension/chrome-extension-allowlist.json` | Committed canonical config (contains the published CWS extension ID) |
| `~/.vellum/chrome-extension-allowlist.local.json` | Per-machine overrides — add your unpacked dev extension ID here |
| `VELLUM_CHROME_EXTENSION_IDS` env var | Comma-separated IDs, useful for CI or one-off testing |

This means the CWS extension and your local dev build work side-by-side with no conflict. You just need to add your dev ID to the local allowlist.

### Adding your dev extension ID

1. Open `chrome://extensions` and find the **ID** shown on your unpacked extension's card.

2. Create (or edit) the local allowlist:

```bash
mkdir -p "$HOME/.vellum"
cat > "$HOME/.vellum/chrome-extension-allowlist.local.json" <<JSON
{
  "version": 1,
  "allowedExtensionIds": ["<id from chrome://extensions>"]
}
JSON
```

3. Restart the assistant — the allowlist is cached at startup.

The IDs are public Chrome extension identifiers, so no special file permissions are needed. Your local allowlist is gitignored and stays on your machine.

## Native Messaging Host Setup

The native messaging host lets the extension discover running assistants via the local lockfile.

### With the macOS app (recommended)

The macOS app installs the native messaging host automatically on every launch. It reads all merged allowlist IDs and writes them into the manifest's `allowed_origins`, so both the CWS extension and your dev build are accepted. After adding your dev ID to the local allowlist (see above), just restart the macOS app and Chrome.

### Manual setup (without the macOS app)

If you're not using the macOS app, set up the native messaging host manually:

1. Install the helper's dependencies (no build step — the dev wrapper runs `bun` against `src/index.ts` directly, so the `dist/` directory is only needed for tests and release builds):

```bash
cd clients/chrome-extension/native-host
bun install
```

2. Export your extension ID(s). Include both the CWS ID (from the canonical allowlist) and your dev ID if you want both to work:

```bash
export CWS_EXTENSION_ID=$(cat ../../../meta/browser-extension/chrome-extension-allowlist.json | grep -oE '[a-p]{32}')
export DEV_EXTENSION_ID=<id from chrome://extensions>
```

3. Install the Chrome native messaging manifest. **Run this from the same `native-host/` directory as step 1** — the snippet reads `$(pwd)/src/index.ts`:

```bash
NATIVE_HOST_ENTRY="$(pwd)/src/index.ts"
BUN_BIN="$(command -v bun)"
NATIVE_HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

if [ -z "$BUN_BIN" ]; then echo "bun not found on PATH" >&2; exit 1; fi

mkdir -p "$NATIVE_HOSTS_DIR"

cat > "$NATIVE_HOSTS_DIR/com.vellum.daemon.sh" <<BASH
#!/bin/bash
exec "$BUN_BIN" "$NATIVE_HOST_ENTRY" "\$@"
BASH
chmod 755 "$NATIVE_HOSTS_DIR/com.vellum.daemon.sh"

cat > "$NATIVE_HOSTS_DIR/com.vellum.daemon.json" <<JSON
{
  "name": "com.vellum.daemon",
  "description": "Vellum assistant native messaging host",
  "path": "$NATIVE_HOSTS_DIR/com.vellum.daemon.sh",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$CWS_EXTENSION_ID/",
    "chrome-extension://$DEV_EXTENSION_ID/"
  ]
}
JSON
chmod 644 "$NATIVE_HOSTS_DIR/com.vellum.daemon.json"
```

> Chrome launches native hosts with a minimal environment, so `#!/usr/bin/env bun` often fails. Use a wrapper script with an absolute Bun path instead.
>
> Pointing the wrapper at `src/index.ts` (rather than `dist/index.js`) means the helper always runs the current source — no stale-`dist/` failures after editing `src/`. Bun executes TypeScript natively.

4. Fully quit and relaunch Chrome.

## Troubleshooting

### No assistants shown in popup

- Verify an assistant is running: check `~/.vellum.lock.json`
- Verify the native messaging host is installed (see above)
- Check the service worker console for `native messaging` errors

### Common error messages

| Error | Cause / Fix |
|---|---|
| `Access to the specified native messaging host is forbidden` | Manifest missing/invalid, or extension ID not in the allowlist. Add it to `~/.vellum/chrome-extension-allowlist.local.json` (see Extension ID & Allowlisting above). |
| `Native host has exited` | Chrome couldn't launch Bun. Use a wrapper script with an absolute Bun path in the manifest. |
| `assistant pair request failed with HTTP 401` | Extension ID not in allowlist. Add it to `~/.vellum/chrome-extension-allowlist.local.json` and restart the assistant (see Extension ID & Allowlisting above). |
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
