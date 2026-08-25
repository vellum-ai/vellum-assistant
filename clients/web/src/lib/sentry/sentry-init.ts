import { Capacitor } from "@capacitor/core";
import type { BrowserOptions } from "@sentry/react";

import { snapshotCommitPressure } from "@/lib/commit-pressure";
import { diagnosticsConsentGranted } from "@/lib/sentry/consent-gate";
import {
  installSentryControlListeners,
  syncSentryClient,
} from "@/lib/sentry/sentry-control";
import { syncDiagnosticsToMain } from "@/runtime/diagnostics";
import { sanitizeUrl } from "@/lib/sentry/url-sanitize";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";
import {
  detectClientOs,
  detectElectronHostOS,
} from "@/runtime/platform-detection";

/**
 * Recognize React's nested-update-limit error in every form it ships as.
 *
 * The expanded sentence only exists in the development bundle:
 * `react-dom-client.production.js` throws `formatProdErrorMessage(185)`, which
 * reads "Minified React error #185; visit https://react.dev/errors/185 …".
 * Sentry expands it server-side for display, so the stored events read like
 * the development text while the value reaching `beforeSend` — client-side,
 * pre-transmit — is the minified one. Matching only the sentence would mean
 * the enrichment never ran anywhere it matters.
 *
 * The digit guards keep `#185` from also matching a future `#1850`.
 */
const REACT_ERROR_185 =
  /Maximum update depth exceeded|Minified React error #185(?!\d)|react\.dev\/errors\/185(?!\d)/;

function isReactError185(message: string): boolean {
  return REACT_ERROR_185.test(message);
}

/** Resolve the Sentry DSN for the current host. */
function resolveDsn(): string | undefined {
  if (isElectron()) {
    return detectElectronHostOS() === "windows"
      ? import.meta.env.VITE_SENTRY_DSN_WINDOWS
      : import.meta.env.VITE_SENTRY_DSN_MACOS;
  }
  if (isNativePlatform()) {
    const platform = Capacitor.getPlatform();
    if (platform === "android") {
      return import.meta.env.VITE_SENTRY_DSN_ANDROID;
    }
    return import.meta.env.VITE_SENTRY_DSN_IOS;
  }
  return import.meta.env.VITE_SENTRY_DSN;
}

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
 * `beforeSend` enriches React's `Maximum update depth exceeded` with the
 * commit-pressure snapshot — that error's stack frame is a bystander, so
 * without the extra context the events are not actionable.
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
  beforeSend(event) {
    // React error 185 is thrown from whatever `setState` runs after the nested
    // update limit is already breached, so its stack names a bystander — every
    // occurrence so far has blamed a different frame. Attach the update
    // traffic that was actually in flight so the next one names the cause.
    // See `lib/commit-pressure.ts`.
    const raisedMaxUpdateDepth = event.exception?.values?.some(
      (value) => value.value != null && isReactError185(value.value),
    );
    if (!raisedMaxUpdateDepth) {
      return event;
    }
    const pressure = snapshotCommitPressure();
    if (!pressure) {
      return event;
    }
    return {
      ...event,
      contexts: { ...event.contexts, commit_pressure: { ...pressure } },
    };
  },
  beforeBreadcrumb(breadcrumb) {
    const data = breadcrumb.data;
    if (!data || typeof data !== "object") {
      return breadcrumb;
    }
    const next: Record<string, unknown> = { ...data };
    for (const key of ["url", "to", "from"] as const) {
      const value = next[key];
      if (typeof value === "string") {
        next[key] = sanitizeUrl(value);
      }
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
 * Bootstrap Sentry consent gating.
 *
 * Also syncs the effective (session-gated) reporting gate to the Electron main
 * process (no-op on web and native mobile) so the main-process Sentry client
 * matches.
 */
export function initSentry(): void {
  // Resolve host-detected values at init time (post host-detection), not at
  // module load. `client_os` tags every event with the OS surface — the web
  // DSN otherwise can't distinguish mobile-web (iOS/Android phone browsers)
  // from desktop. Shares the product `detectClientOs()` so Sentry, analytics,
  // and the assistant's `client_os` context all agree.
  const resolved: BrowserOptions = {
    ...options,
    dsn: resolveDsn(),
    initialScope: { tags: { client_os: detectClientOs() } },
  };
  syncSentryClient(resolved);
  installSentryControlListeners(resolved);
  syncDiagnosticsToMain(diagnosticsConsentGranted());
}
