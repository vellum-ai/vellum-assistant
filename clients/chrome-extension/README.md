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

## Extension ID

Chrome assigns each extension a unique 32-character ID. Non-production builds inject a deterministic `key` into the manifest from [`extension-environments.json`](./extension-environments.json), so every developer running the same environment gets the same stable extension ID — no manual setup needed.

Each environment also gets its own icon set (under `icons/<env>/`), making it easy to distinguish side-by-side installs at a glance.

## Troubleshooting

| Error | Cause / Fix |
|---|---|
| `failed to reach assistant at http://127.0.0.1:<port>/...` | Assistant not running, wrong port, or firewall blocking. |
| `Automatic cloud sign-in failed` | Use "Re-sign in" in the popup's Troubleshooting section, then click Connect. |
| `Automatic local pairing failed` | Use "Re-pair" in the popup's Troubleshooting section, then click Connect. |

## Tests

Extension:

```bash
cd clients/chrome-extension
bunx tsc --noEmit
bun test background/__tests__/self-hosted-auth.test.ts
bun test background/__tests__/worker-selected-assistant-connect.test.ts
bun test background/__tests__/relay-connection.test.ts
```
