import { getClient, getCurrentScope, init } from "@sentry/electron/renderer";

import type { SentryFlavor } from "@/lib/sentry/flavor";

/**
 * `SentryFlavor` backed by `@sentry/electron/renderer`, used inside the
 * Electron renderer (which also runs the web bundle).
 *
 * Renderer events route to the main process over the default IPC transport,
 * so they land in the macOS project (`vellum-assistant-macos`) correlated with
 * main-process events instead of commingling with the web project.
 */
export const electronFlavor: SentryFlavor = {
  init(options) {
    // @sentry/electron bundles its own @sentry/core (10.50) whose `Integration`
    // type predates the 10.52 one behind our shared `BrowserOptions`. The trees
    // are structurally compatible at runtime; bridge them at this boundary.
    init({ ...options, enabled: true } as Parameters<typeof init>[0]);
  },
  close() {
    // The renderer SDK has no top-level `close`; tear down the browser client
    // directly. The main process owns native crash reporting and its own
    // opt-out, so closing the renderer client is sufficient here.
    const client = getClient();
    if (!client) return;
    void client.close(2000);
    getCurrentScope().setClient(undefined);
  },
  getClientEnabled() {
    const client = getClient();
    return client !== undefined && client.getOptions().enabled !== false;
  },
};
