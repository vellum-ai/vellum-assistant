import * as Capacitor from "@sentry/capacitor";
import { init as reactInit } from "@sentry/react";

import type { SentryFlavor } from "@/lib/sentry/flavor";
import { diagnosticsConsentGranted } from "@/lib/sentry/consent-gate";

/**
 * `SentryFlavor` backed by `@sentry/capacitor`, used inside the iOS WKWebview.
 *
 * `init` wraps the sibling `@sentry/react` SDK (passed as `originalInit`) so
 * the JS layer routes through the native sentry-cocoa transport. The native
 * bridge dedups events captured on both sides, so webview errors are not
 * double-reported.
 *
 * Native fail-closed guarantee (iOS sentry-cocoa)
 * -----------------------------------------------
 * sentry-cocoa never auto-starts: `@sentry/capacitor` initializes native only
 * via `Capacitor.init` → `initNativeSdk` (verified in the SDK source), and the
 * prior linking PR confirmed there is no Info.plist Sentry block. This flavor
 * is driven solely through the consent-gated path in `sentry-control.ts`, so
 * native capture begins ONLY after consent is granted. A crash that occurs
 * before consent is therefore never captured at all — fail-closed by
 * construction.
 *
 * sentry-cocoa flushes crash envelopes cached from a prior session on its next
 * native init. Because that init only fires when consent is currently granted,
 * a cached crash is flushed only if the user remains opted in across launches
 * (correct). If consent was revoked, `init` never runs, the native SDK never
 * starts, and the cached envelope is never uploaded. There is no native
 * cache-purge API in `@sentry/capacitor` 4.1.0 (only `closeNativeSdk`), so this
 * gated-init contract IS the purge.
 *
 * The JS `beforeSend` below gates webview JS errors, which DO round-trip
 * through it. It is NOT the native gate: on iOS the SDK skips `beforeSend` for
 * native envelopes captured via `captureEnvelope` (see its SdkInfo
 * integration). The native gate is consent-gated init + `Capacitor.close()`.
 */
export const capacitorFlavor: SentryFlavor = {
  init(options) {
    Capacitor.init(
      {
        ...options,
        enabled: true,
        // Defensive gate for JS-bridged webview events; native envelopes
        // bypass beforeSend, so consent-gated init + close is the native gate.
        beforeSend: (event) => (diagnosticsConsentGranted() ? event : null),
      },
      reactInit,
    );
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
