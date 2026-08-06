import * as Capacitor from "@sentry/capacitor";
import { init as reactInit } from "@sentry/react";

import type { SentryFlavor } from "@/lib/sentry/flavor";
import { diagnosticsConsentGranted } from "@/lib/sentry/consent-gate";
import {
  startNativeFailureReportForwarding,
  stopNativeFailureReportForwarding,
} from "@/runtime/native-failure-reports";

/**
 * `SentryFlavor` backed by `@sentry/capacitor`, used inside native mobile
 * WebViews on iOS and Android.
 *
 * `init` wraps the sibling `@sentry/react` SDK (passed as `originalInit`) so
 * the JS layer routes through the native transport. The native bridge dedups
 * events captured on both sides, so WebView errors are not double-reported.
 *
 * Native fail-closed guarantee
 * ----------------------------
 * `@sentry/capacitor` initializes the native SDK only through
 * `Capacitor.init` and `initNativeSdk`. The iOS shell has no Info.plist
 * Sentry block, and the Android app manifest disables sentry-android
 * auto-init. This flavor is driven solely through the consent-gated path in
 * `sentry-control.ts`, so native capture begins only after consent is granted.
 * A crash before consent is never captured.
 *
 * On iOS, sentry-cocoa flushes crash envelopes cached from a prior session on
 * its next native init. Because that init only fires when consent is currently
 * granted, a cached crash is flushed only if the user remains opted in across
 * launches. If consent was revoked, `init` never runs, the native SDK never
 * starts, and the cached envelope is never uploaded. There is no native cache
 * purge API in `@sentry/capacitor` 4.1.0, so consent-gated initialization is
 * the iOS purge contract.
 *
 * The JS `beforeSend` below gates WebView JS errors that round-trip through it.
 * It is not the native gate. On iOS, the SDK skips `beforeSend` for native
 * envelopes captured via `captureEnvelope` (see its SdkInfo integration).
 * Native capture on both platforms is gated by consent-controlled init and
 * `Capacitor.close()`.
 */
export const capacitorFlavor: SentryFlavor = {
  init(options) {
    const enrich = options.beforeSend;
    Capacitor.init(
      {
        ...options,
        enabled: true,
        // Defensive gate for JS-bridged webview events; native envelopes
        // bypass beforeSend, so consent-gated init + close is the native gate.
        //
        // Composed, not replaced: the caller's `beforeSend` carries the
        // diagnostic enrichment every surface should get (see `sentry-init`),
        // and overwriting it here would silently exempt native mobile. The
        // consent check stays first so a denied event is dropped before any
        // work is done on it. The gate is not weakened by what runs after it.
        beforeSend: (event, hint) => {
          if (!diagnosticsConsentGranted()) {
            return null;
          }
          return enrich ? enrich(event, hint) : event;
        },
      },
      (browserOptions) => {
        reactInit(browserOptions);
        void startNativeFailureReportForwarding();
      },
    );
  },
  async close() {
    // Use the Capacitor SDK's own close routine, which shuts down BOTH the JS
    // client and the native SDK. Closing only the JS client would leave native
    // crash reporting running after an opt-out.
    await stopNativeFailureReportForwarding();
    await Capacitor.close();
  },
  getClientEnabled() {
    const client = Capacitor.getClient();
    return client !== undefined && client.getOptions().enabled !== false;
  },
};
