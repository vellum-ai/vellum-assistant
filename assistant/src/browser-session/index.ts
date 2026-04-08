/**
 * BrowserSessionManager — multi-backend session router for host_browser.
 *
 * Phase 2 hand-off: this module has no production consumers yet. The
 * `extension` backend is wired structurally so the daemon's HostBrowserProxy
 * can delegate to it in Phase 3. Phase 3 will:
 *   1. Migrate `assistant/src/tools/browser/browser-execution.ts` to call
 *      `BrowserSessionManager.send()` instead of the legacy `browserManager`
 *      sacrificial-profile path.
 *   2. Add a Playwright backend for cloud-runtime headless sessions (Phase 5).
 *
 * Until Phase 3 lands, the only consumers are the unit tests in
 * `__tests__/manager.test.ts`.
 *
 * See `docs/browser-use-architecture-phase2.md` for the full hand-off context.
 */
export * from "./backends/extension.js";
export * from "./manager.js";
export * from "./types.js";
