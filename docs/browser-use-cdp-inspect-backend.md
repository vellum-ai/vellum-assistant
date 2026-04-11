# Browser Use — `cdp-inspect` Backend

The `cdp-inspect` backend connects the assistant directly to an
already-running Chrome instance via the DevTools JSON protocol
(`--remote-debugging-port`). It avoids the per-tab debugger infobar
that the Chrome extension transport shows, at the cost of broader
session-level access.

**This is an explicit, advanced backend.** The Chrome extension is the
default and preferred transport for browser use. The extension maintains a
long-lived background connection with automatic reconnect and silent token
refresh, so users never need to fall back to `cdp-inspect` during transient
extension interruptions. The assistant's CDP client factory enforces this:
when the extension transport is provisioned for a conversation but
temporarily unavailable (e.g. mid-reconnect), `cdp-inspect` is
intentionally skipped in the desktop-auto candidate list to prevent silent
takeover.

## Backend comparison

| | **Extension** | **cdp-inspect** | **Local** |
|---|---|---|---|
| Chrome instance | User's own Chrome via chrome.debugger | User's own Chrome via `--remote-debugging-port` | Sacrificial-profile Chromium managed by Playwright |
| Requires install | Chrome extension | None (Chrome flag only) | Playwright browser download |
| Debugger infobar | Yes (per tab) | No | No (dedicated profile) |
| Tab scope | Single active tab | Any open tab | Dedicated browser |
| Auth/session access | Active tab only | All tabs, all cookies | Isolated profile |
| Selection priority | 1st (highest) | 2nd (when explicitly enabled) | 3rd (default) |

## When to use this backend

**Prefer the Chrome extension.** It provides the best security boundary
(single-tab scope, visible debugger infobar, chrome.debugger permission
model), requires no special Chrome launch flags, and handles all lifecycle
management automatically (keepalive, reconnect, token refresh).

Use `cdp-inspect` only when:

- You cannot install the Chrome extension (e.g. enterprise policy,
  Chromium-based browser without extension support).
- You want to avoid the yellow "started debugging this browser" infobar
  that `chrome.debugger.attach` displays.
- You are running in a headless/CI environment where a user-profile
  Chrome is already running with `--remote-debugging-port`.
- You are intentionally opting into broad session-level access for
  advanced debugging or automation workflows.

## Relationship to extension transport

The CDP client factory (`cdp-client/factory.ts`) builds an ordered
candidate list for each browser tool invocation:

1. **Extension** — always first when the extension proxy is connected.
2. **cdp-inspect** — included only when *explicitly enabled* in config,
   OR via the macOS desktop-auto path when no extension proxy exists
   for the conversation. When the extension proxy exists but is
   temporarily unavailable (reconnecting), cdp-inspect is deliberately
   **excluded** to prevent silent backend drift during transient
   extension disconnects.
3. **Local** (Playwright) — default fallback.

This means `cdp-inspect` does not silently "take over" when the extension
has a brief interruption. The extension's automatic recovery (keepalive +
exponential-backoff reconnect + silent token refresh) is given time to
restore the connection before any fallback is considered.

## Security considerations

### Real-session control

When the assistant attaches via `cdp-inspect`, it can read and act on
**any tab** in the target Chrome instance — including tabs with active
sessions for email, banking, chat, and other authenticated services.
The extension backend, by contrast, only operates on the single tab the
user activates.

### Phishing and page-content risk

DOM content retrieved via CDP is untrusted. The extension backend
mitigates this partially through the `chrome.debugger` permission model
and the visible infobar, which signals to the user that debugging is
active. The `cdp-inspect` backend has no equivalent per-site allowlist
or visible indicator in the browser chrome.

### Loopback-only by policy

The discovery layer (`probeDevToolsJsonVersion`) refuses to connect to
any host that is not `localhost`, `127.0.0.1`, `::1`, or `[::1]`. Remote attach is
rejected with a `non_loopback` error before any network I/O occurs.

**Warning:** The Chrome DevTools HTTP/WebSocket port has **no
authentication**. Any process on the same machine can connect to it.
Only enable `--remote-debugging-port` on machines where you trust all
running processes.

## Enabling the backend

### macOS Settings UI

Open **macOS Settings → Developer → Browser backend** and select the
**"Use your own Chrome (Advanced)"** card. This sets the config key
below automatically.

### JSON config

Add or update the following keys in your assistant config
(`~/.vellum/workspace/config.json`):

```json
{
  "hostBrowser": {
    "cdpInspect": {
      "enabled": true,
      "host": "localhost",
      "port": 9222,
      "probeTimeoutMs": 500
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `hostBrowser.cdpInspect.enabled` | boolean | `false` | Enable the cdp-inspect backend. |
| `hostBrowser.cdpInspect.host` | string | `"localhost"` | Loopback host for the DevTools endpoint. Must be `localhost`, `127.0.0.1`, `::1`, or `[::1]`. |
| `hostBrowser.cdpInspect.port` | number | `9222` | TCP port matching `--remote-debugging-port`. |
| `hostBrowser.cdpInspect.probeTimeoutMs` | number | `500` | Timeout (ms) for the discovery probe. Increase if Chrome is slow to respond. |

## Launching Chrome with remote debugging

You must launch Chrome with `--remote-debugging-port` before the
assistant can attach. Close all existing Chrome instances first, then
run one of the commands below.

### macOS

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222
```

### Linux

```bash
google-chrome --remote-debugging-port=9222
```

### Windows

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222
```

> **Tip:** If Chrome is already running without the flag, the port will
> not be opened. Quit Chrome completely and relaunch with the flag.

## Verifying the DevTools endpoint

Once Chrome is running with `--remote-debugging-port`, confirm the
endpoint is reachable:

```bash
# Version info — confirms Chrome is listening
curl http://localhost:9222/json/version

# Open targets — lists all debuggable tabs/pages
curl http://localhost:9222/json/list
```

A successful `/json/version` response contains `Browser`, `Protocol-Version`,
and `webSocketDebuggerUrl` fields. A successful `/json/list` response is
a JSON array of target objects, each with `id`, `type`, `title`, `url`,
and `webSocketDebuggerUrl`.

## Troubleshooting

The assistant surfaces `DevToolsDiscoveryError` codes when the
cdp-inspect backend cannot reach or identify the DevTools endpoint.

| Error code | Likely cause | Fix |
|---|---|---|
| `unreachable` | Chrome is not running with `--remote-debugging-port`, or the configured port is wrong. | Launch Chrome with `--remote-debugging-port=9222` and verify with `curl http://localhost:9222/json/version`. |
| `non_loopback` | The configured `host` is not `localhost`, `127.0.0.1`, `::1`, or `[::1]`. | Set `hostBrowser.cdpInspect.host` to `"localhost"`. Remote attach is refused by policy. |
| `non_chrome` | Something other than Chrome is bound to port 9222. | Check what process is using the port (`lsof -i :9222` on macOS/Linux) and either stop it or change the configured port. |
| `invalid_response` | The port responds but is not speaking the DevTools protocol. | Verify with `curl http://localhost:9222/json/version`. If the response is not valid JSON with a `Browser` field, another service is using the port. |
| `no_targets` | Chrome is running but has no open tabs or pages. | Open at least one tab in Chrome before using browser tools. |
| `timeout` | Chrome is slow to respond to the discovery probe. | Increase `hostBrowser.cdpInspect.probeTimeoutMs` (max 5000). |
