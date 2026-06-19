import * as Capacitor from "@sentry/capacitor";
import { init as reactInit } from "@sentry/react";

import type { SentryFlavor } from "@/lib/sentry/flavor";

/**
 * `SentryFlavor` backed by `@sentry/capacitor`, used inside the iOS WKWebview.
 *
 * `init` wraps the sibling `@sentry/react` SDK (passed as `originalInit`) so
 * the JS layer routes through the native sentry-cocoa transport. The native
 * bridge dedups events captured on both sides, so webview errors are not
 * double-reported.
 */
export const capacitorFlavor: SentryFlavor = {
  init(options) {
    Capacitor.init({ ...options, enabled: true }, reactInit);
  },
  close() {
    // Use the Capacitor SDK's own close routine, which shuts down BOTH the JS
    // client and the native sentry-cocoa SDK. Closing only the JS client would
    // leave native crash reporting running after an opt-out.
    return Capacitor.close();
  },
  getClientEnabled() {
    const client = Capacitor.getClient();
    return client !== undefined && client.getOptions().enabled !== false;
  },
};
