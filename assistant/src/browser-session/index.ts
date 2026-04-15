/**
 * BrowserSessionManager — multi-backend session router for host_browser.
 *
 * This module is the single CDP backend selector for browser tools. The
 * `cdp-client` factory (`assistant/src/tools/browser/cdp-client/factory.ts`)
 * constructs a BrowserSessionManager per tool invocation, registers the
 * appropriate backend from a three-way selection:
 *
 *  1. **Extension** — selected when `hostBrowserProxy` is present (macOS
 *     desktop / cloud-hosted with a chrome-extension bound to the
 *     conversation).
 *  2. **cdp-inspect** — selected when the extension is absent and
 *     `hostBrowser.cdpInspect.enabled` is `true` in config. Attaches to
 *     an already-running Chrome via `--remote-debugging-port`.
 *  3. **Local** — default when neither of the above applies.
 *     Drives a Playwright-backed sacrificial-profile Chromium.
 *
 * The factory exposes a `ScopedCdpClient` that routes `send()` through
 * the manager. This gives every call site a single choke point for
 * session invalidation and future multi-tab routing.
 */
export * from "./backends/cdp-inspect.js";
export * from "./backends/extension.js";
export * from "./backends/local.js";
export * from "./events.js";
export * from "./manager.js";
export * from "./types.js";
