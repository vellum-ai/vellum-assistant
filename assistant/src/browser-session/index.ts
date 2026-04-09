/**
 * BrowserSessionManager — multi-backend session router for host_browser.
 *
 * This module is the single CDP backend selector for browser tools. The
 * `cdp-client` factory (`assistant/src/tools/browser/cdp-client/factory.ts`)
 * constructs a BrowserSessionManager per tool invocation, registers the
 * appropriate backend (extension when `hostBrowserProxy` is present, local
 * Playwright-backed backend otherwise), and exposes a `ScopedCdpClient` that
 * routes `send()` through the manager. This gives every call site a single
 * choke point for session invalidation and future multi-tab routing.
 */
export * from "./backends/extension.js";
export * from "./backends/local.js";
export * from "./events.js";
export * from "./manager.js";
export * from "./types.js";
