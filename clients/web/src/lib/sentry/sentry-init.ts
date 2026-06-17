import type { BrowserOptions } from "@sentry/react";

import {
  installSentryControlListeners,
  syncSentryClient,
} from "@/lib/sentry/sentry-control";
import { sanitizeUrl } from "@/lib/sentry/url-sanitize";

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
 * `beforeBreadcrumb` strips auth codes, invite tokens, and OAuth fragment
 * tokens from URLs the browser SDK records on navigation / fetch / XHR.
 * Regex-based scrubbing of CC/SSN/password patterns is handled by
 * Sentry's server-side Advanced Data Scrubbing (configured per-project
 * in the dashboard), per Sentry's recommended layering.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/configuration/filtering/
 * Reference: https://docs.sentry.io/security-legal-pii/scrubbing/
 */
const options: BrowserOptions = {
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "local",
  release: import.meta.env.VITE_APP_VERSION,
  tracesSampleRate: 0,
  // The SDK patches `window.fetch` and, in the default `'always'` mode,
  // mutates `TypeError.message` in-place to append the hostname (e.g.
  // "Failed to fetch" → "Failed to fetch (www.vellum.ai)"). This breaks
  // any code that pattern-matches on the original browser message — in
  // particular `isTransientNetworkError()`, which gates Sentry reporting
  // and user-facing error toasts.
  //
  // `'report-only'` stores the hostname in a hidden non-enumerable
  // property and uses it only when building the Sentry event, so
  // application code sees the original browser message while Sentry
  // events still show the enriched hostname for debugging context.
  //
  // Reference: https://github.com/getsentry/sentry-javascript/pull/18466
  // Reference: https://docs.sentry.io/platforms/javascript/configuration/options/#enhancefetcherrormessages
  enhanceFetchErrorMessages: "report-only",
  // Attach a synthetic JS stack to `Sentry.captureMessage` calls so events
  // emitted without a thrown exception still resolve to a source location
  // after sourcemap upload.
  // Reference: https://docs.sentry.io/platforms/javascript/configuration/options/#attach-stacktrace
  attachStacktrace: true,
  beforeBreadcrumb(breadcrumb) {
    const data = breadcrumb.data;
    if (!data || typeof data !== "object") return breadcrumb;
    const next: Record<string, unknown> = { ...data };
    for (const key of ["url", "to", "from"] as const) {
      const value = next[key];
      if (typeof value === "string") next[key] = sanitizeUrl(value);
    }
    return { ...breadcrumb, data: next };
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
    // Transient network TypeErrors — browser-engine rejections when fetch()
    // is cancelled by page navigation, device sleep, or network drop. These
    // reach the SDK via GlobalHandlers' `onunhandledrejection` hook for
    // browser-internal promise rejections during navigation that JavaScript
    // cannot attach handlers to. Application-level filtering already gates
    // manual captures via `captureError()` + `isTransientNetworkError()`;
    // these patterns close the same gap for the SDK's automatic paths.
    /^Load failed($| \()/,
    /^Failed to fetch($| \()/,
    /^NetworkError when attempting to fetch resource\.?($| \()/,
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

/**
 * Bootstrap Sentry consent gating. Must be called after
 * `migrateDeviceSettings()` so the `device:share_diagnostics` key
 * is available when `readConsent()` reads localStorage.
 */
export function initSentry(): void {
  syncSentryClient(options);
  installSentryControlListeners(options);
}
