# Browser Use — `cdp-inspect` Backend

This doc describes how to set up and use the **`cdp-inspect` backend**,
an advanced option that lets the Vellum assistant drive your **existing,
logged-in Chrome browser** by attaching to Chrome's built-in DevTools
remote debugging endpoint over loopback.

It is the third available browser backend:

| Backend | When it is used |
|---|---|
| `extension` | The Vellum Chrome extension is installed and paired. |
| `cdp-inspect` | Extension is absent and `hostBrowser.cdpInspect.enabled` is `true`. |
| `local` | Neither extension nor `cdp-inspect` is available — the assistant falls back to a Playwright-managed Chromium. |

> **Warning:** The `cdp-inspect` backend drives **your real Chrome
> profile**. The assistant can read and act on **any** tab that Chrome
> has open, including tabs with access to your email, banking, chat, and
> other logged-in sessions. Only enable this backend if you fully
> understand the risks described in
> [Security considerations](#security-considerations).

## When to use this backend

Use `cdp-inspect` if:

- You can't install the Vellum Chrome extension (managed device policy,
  browser other than stable Chrome, etc.).
- You explicitly want the assistant to operate your real browser
  session rather than a sacrificial Playwright Chromium.
- You accept the security trade-offs documented below.

Prefer the Chrome extension backend in all other cases — it has a
per-tab `chrome.debugger` infobar and does not require you to relaunch
Chrome with a remote debugging port.

## Security considerations

The `cdp-inspect` backend attaches to a running Chrome instance through
Chrome's DevTools Protocol. Once attached, the assistant effectively has
the same reach across tabs and sessions that the Chrome DevTools panel
itself has. Read these points before enabling it.

### Real-session control

- Chrome holds cookies, auth tokens, and signed-in sessions for
  **every** site you are logged into (email, banking, chat, internal
  tools).
- The assistant, when driving that Chrome instance, can see and act on
  **any** tab — not just the one you asked it to work with.
- This is fundamentally different from the Playwright `local` backend,
  which runs a clean, isolated browser that has **none** of your
  personal sessions.

### Phishing and page-content risk

- The assistant observes the DOM of whatever page it operates on. A
  malicious or compromised page can surface content designed to
  manipulate what the assistant sees or does.
- There is no per-site allowlist for `cdp-inspect`. Unlike the Chrome
  extension backend (where the `chrome.debugger` infobar at least marks
  the tab as being driven), `cdp-inspect` attaches at the browser
  level — any tab in the instance is reachable.

### Loopback-only by policy

- The assistant only connects to DevTools endpoints on
  `localhost` / `127.0.0.1` / `::1`. Attaching to a Chrome DevTools
  port on any other host is **blocked** at the discovery layer.
- Remote attach (for example to a DevTools endpoint running on another
  machine or exposed through an SSH tunnel) is not supported and will
  be refused with the `non_loopback` discovery error.
- Even on localhost, Chrome's DevTools port has **no authentication**.
  Anything else on your machine that can reach `127.0.0.1:9222` can
  drive that Chrome instance. Do not expose the port to other users or
  forward it off the loopback interface.

If any of the above is unacceptable in your environment, leave
`hostBrowser.cdpInspect.enabled` set to `false` and use either the
Chrome extension backend or the default Playwright `local` backend.

## Enabling the backend

### Via macOS Settings

1. Open the Vellum Assistant app and go to **Settings → Developer**.
2. Under **Browser backend**, find the **Use your own Chrome (Advanced)**
   card.
3. Read the security explainer on the card — it repeats the key
   points from this doc.
4. Toggle **Use your own Chrome** on.
5. Leave **Host** at `localhost` unless you have a specific reason to
   change it (the assistant will refuse anything that isn't a loopback
   address anyway).
6. Leave **Port** at `9222` unless you are running Chrome with a
   different `--remote-debugging-port` value.

### Via config keys

The same settings are persisted under `hostBrowser.cdpInspect` in the
assistant's config:

```jsonc
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

Field reference:

| Key | Type | Default | Notes |
|---|---|---|---|
| `hostBrowser.cdpInspect.enabled` | `boolean` | `false` | Master switch. `false` means the assistant ignores this backend entirely. |
| `hostBrowser.cdpInspect.host` | `string` | `"localhost"` | Must be `localhost`, `127.0.0.1`, or `::1`. Anything else is rejected as `non_loopback`. |
| `hostBrowser.cdpInspect.port` | `integer` | `9222` | Chrome's `--remote-debugging-port`. |
| `hostBrowser.cdpInspect.probeTimeoutMs` | `integer` | `500` | Timeout for the `/json/version` discovery probe. Raise this if Chrome is slow to respond. |

Any change to these keys takes effect on the next browser tool
invocation — there is no need to restart the assistant.

## Launching Chrome with remote debugging

The `cdp-inspect` backend does **not** start Chrome for you. You have
to launch Chrome yourself with the `--remote-debugging-port=9222` flag
(or whatever port you configured above). Close any already-running
Chrome instances first; Chrome only honours
`--remote-debugging-port` on a fresh launch.

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
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

### Confirming from `chrome://inspect`

Once Chrome is running with remote debugging enabled, you can confirm
from within Chrome itself:

1. In the same Chrome instance, navigate to
   `chrome://inspect/#remote-debugging`.
2. You should see the instance and its open tabs listed as attachable
   targets.

If the page is empty, Chrome is either not running with
`--remote-debugging-port`, or it is running but the flag was ignored
(for example because another Chrome instance was already open).

## Verifying the DevTools endpoint

Before you toggle the backend on, verify that the assistant will be
able to reach Chrome's DevTools endpoint.

### `/json/version`

```bash
curl http://localhost:9222/json/version
```

A healthy response includes fields like `Browser` (e.g.
`Chrome/126.0.6478.127`), `Protocol-Version`, and a
`webSocketDebuggerUrl`. The assistant's discovery layer reads this
endpoint first and refuses to attach to anything that doesn't look
like Chrome/Chromium.

### `/json/list`

```bash
curl http://localhost:9222/json/list
```

This returns a JSON array of attachable targets. The assistant only
uses entries with `"type": "page"` that have a valid
`webSocketDebuggerUrl`. If the array is empty or contains only
DevTools/new-tab pages, attach will fail with `no_targets` — open an
actual page in Chrome and retry.

## Troubleshooting

When attach fails, the assistant surfaces a discovery error code.
Here's how each one maps to a likely cause and fix.

| Error code | Likely cause | Fix |
|---|---|---|
| `unreachable` | Chrome is not running with `--remote-debugging-port`, or you are probing the wrong port. | Relaunch Chrome with the launch command above. Make sure no other Chrome instance is already running — Chrome silently ignores the flag if another instance already owns the profile. |
| `non_loopback` | `hostBrowser.cdpInspect.host` is set to something other than `localhost` / `127.0.0.1` / `::1`. | Edit the host in Settings (or the config file) to a loopback address. The assistant refuses remote attach by design. |
| `non_chrome` | Something is bound to the configured port, but it isn't Chrome. `/json/version` either returned an unexpected response or was served by a different process. | Pick a different port (change both Chrome's launch flag and `hostBrowser.cdpInspect.port`) or stop the conflicting service. |
| `invalid_response` | The port is responding, but the body isn't valid DevTools JSON. Usually a proxy or captive-portal style interception. | Curl `/json/version` directly and inspect the response. Bypass any HTTP proxies on loopback. |
| `no_targets` | Chrome is running and DevTools is live, but there are no attachable page targets — Chrome was launched with no tabs open, or only internal pages are open. | Open at least one normal web page in the running Chrome instance and retry. |
| `timeout` | Chrome is running but the `/json/version` probe didn't return within `probeTimeoutMs`. Common on first launch or heavily loaded machines. | Increase `hostBrowser.cdpInspect.probeTimeoutMs` (valid range 50–5000) in Settings or the config file. |

If the error persists after working through the table above, capture
the assistant logs around the failed browser tool invocation and
include them in your bug report.

## See also

- [Browser Use Architecture — Phase 2](./browser-use-architecture-phase2.md) —
  full architecture context, including the extension transport and the
  generic `host_browser_request` / `host_browser_result` envelope pair.
