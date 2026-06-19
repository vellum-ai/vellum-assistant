import * as Sentry from "@sentry/react";

import type { SentryFlavor } from "@/lib/sentry/flavor";

/**
 * `SentryFlavor` backed by `@sentry/react`, the browser SDK used on the web
 * app and the Electron renderer.
 */
export const reactFlavor: SentryFlavor = {
  init(options) {
    Sentry.init({ ...options, enabled: true });
  },
  close() {
    const client = Sentry.getClient();
    if (!client) return;
    void client.close(2000);
    Sentry.getCurrentScope().setClient(undefined);
  },
  getClientEnabled() {
    const client = Sentry.getClient();
    return client !== undefined && client.getOptions().enabled !== false;
  },
};
