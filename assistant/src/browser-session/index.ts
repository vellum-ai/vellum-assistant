/**
 * BrowserSessionManager — multi-backend session router for host_browser.
 *
 * This module is the single CDP backend selector for browser tools. The
 * `cdp-client` factory (`assistant/src/tools/browser/cdp-client/factory.ts`)
 * constructs a BrowserSessionManager per tool invocation, registers one of
 * three backends, and exposes a `ScopedCdpClient` that routes `send()`
 * through the manager. This gives every call site a single choke point for
 * session invalidation and future multi-tab routing.
 *
 * Backend selection (3-way):
 *   - `extension`  — routes CDP through `hostBrowserProxy` (chrome.debugger)
 *     when the extension is connected. Used for the user's own Chrome.
 *   - `cdp-inspect` — connects directly to a host Chrome instance launched
 *     with `--remote-debugging-port` when the `hostBrowser.cdpInspect`
 *     probe succeeds. Used as a fallback before falling through to local.
 *   - `local`      — Playwright-backed headless Chromium in the same
 *     process. Used when neither extension nor cdp-inspect is available.
 */
export * from "./backends/extension.js";
export * from "./backends/local.js";
export * from "./events.js";
export * from "./manager.js";
export * from "./types.js";
