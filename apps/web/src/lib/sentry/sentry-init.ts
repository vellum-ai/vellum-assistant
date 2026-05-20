import type { BrowserOptions } from "@sentry/react";

import {
  installSentryControlListeners,
  syncSentryClient,
} from "@/lib/sentry/sentry-control.js";
import { redactObject, redactString } from "@/lib/sentry/redact.js";

/**
 * Browser-side Sentry initialization, gated on the user's Share Diagnostics
 * consent toggle.
 *
 * `ignoreErrors` matches `event.exception.values[*].value`;
 * `denyUrls` matches the top stack-frame URL. Both run in the SDK before
 * transmit, so matched events never count against project quota. Filters
 * here must never match errors raised from `src/` — fix those at the call
 * site so real regressions are not hidden.
 *
 * `beforeSend` / `beforeBreadcrumb` strip PII (emails, card numbers,
 * SSNs) from exception values, breadcrumbs, and extra context — same
 * policy as `assistant/src/instrument.ts`.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/configuration/filtering/
 */
const options: BrowserOptions = {
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "local",
  tracesSampleRate: 0,
  // Defaults to false in @sentry/react v10+, but set explicitly so a future
  // SDK default flip doesn't silently start sending IP / user-agent / cookies.
  sendDefaultPii: false,
  // Attach a synthetic JS stack to `Sentry.captureMessage` calls so events
  // emitted without a thrown exception still resolve to a source location
  // after sourcemap upload.
  // Reference: https://docs.sentry.io/platforms/javascript/configuration/options/#attach-stacktrace
  attachStacktrace: true,
  beforeSend(event) {
    if (event.exception?.values) {
      event.exception.values = event.exception.values.map((ex) => ({
        ...ex,
        value: ex.value ? redactString(ex.value) : ex.value,
      }));
    }
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map((bc) => ({
        ...bc,
        message: bc.message ? redactString(bc.message) : bc.message,
        data: bc.data
          ? (redactObject(bc.data) as Record<string, unknown>)
          : bc.data,
      }));
    }
    if (event.extra) {
      event.extra = redactObject(event.extra) as Record<string, unknown>;
    }
    if (event.message) {
      event.message = redactString(event.message);
    }
    return event;
  },
  beforeBreadcrumb(breadcrumb) {
    return {
      ...breadcrumb,
      message: breadcrumb.message
        ? redactString(breadcrumb.message)
        : breadcrumb.message,
      data: breadcrumb.data
        ? (redactObject(breadcrumb.data) as Record<string, unknown>)
        : breadcrumb.data,
    };
  },
  ignoreErrors: [
    // Chrome/Safari Translate mutates text nodes after a React commit;
    // the reconciler fails to reconcile against the rewritten DOM.
    /Failed to execute 'removeChild' on 'Node'/,
    /Failed to execute 'insertBefore' on 'Node'/,
    /The object can not be found here/,
    // Wallet/crypto extensions inject content scripts. Vellum never calls
    // MetaMask, Tron, or `window.ethereum`.
    /Failed to connect to MetaMask/,
    /Cannot set property tron of/,
    /Cannot redefine property: ethereum/,
    // Browser-extension content-script lifecycle noise.
    /Extension context invalidated/,
    /Invalid call to runtime\.sendMessage/,
  ],
  denyUrls: [
    // Browser-extension schemes.
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    /^safari-(?:web-)?extension:\/\//,
    /^webkit-masked-url:/,
    // Conventional wallet/extension injection basenames.
    /\/inpage\.js$/,
    /\/injectedScript\.bundle\.js$/,
    // Third-party marketing/analytics pixels.
    /px\.ads\.linkedin\.com/,
  ],
};

syncSentryClient(options);
installSentryControlListeners(options);
