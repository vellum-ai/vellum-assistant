/**
 * Pure utilities for the Capacitor OAuth-completion deep link.
 *
 * On Capacitor iOS, integration OAuth runs inside `SFSafariViewController`
 * (WKWebView's `window.open` is broken without a `WKUIDelegate`, see
 * https://developer.apple.com/documentation/webkit/wkuidelegate). The sheet
 * ignores `window.close()` and runs in a separate process from the host
 * app, so the postMessage / `localStorage` channels the web flow uses for
 * completion detection are no-ops on native (cf.
 * https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller).
 *
 * Apple's prescribed pattern for round-tripping back into a host app from
 * `SFSafariViewController` is a custom URL scheme: redirecting
 * `window.location.href = "<scheme>://oauth-complete?…"` inside the sheet
 * causes iOS to dismiss it and route the URL into the registered app via
 * `application(_:open:options:)`. Capacitor surfaces that as the
 * `appUrlOpen` listener event:
 * https://capacitorjs.com/docs/apis/app#addlistenerappurlopen-
 *
 * This module exposes the pure pieces of that protocol:
 *   - `getNativeUrlSchemeForHost(host)` — hostname → build-target
 *     `BUNDLE_URL_SCHEME` map (the iOS xcconfigs pair each
 *     `ASSOCIATED_DOMAIN` with a unique `BUNDLE_URL_SCHEME` 1-to-1).
 *   - `buildOAuthCompleteDeepLink(scheme, payload)` — canonical URL
 *     builder used by the `popup-complete` page producer.
 *   - `parseOAuthCompleteDeepLink(rawUrl)` — strict parser used by the
 *     `appUrlOpen` consumer; rejects unrecognised schemes, wrong hosts,
 *     and missing `requestId`.
 *   - `OAUTH_COMPLETE_DEEP_LINK_EVENT` — the window-event name the router
 *     dispatches parsed payloads on, for consumers that don't depend on
 *     `@capacitor/app` directly.
 *
 * The React side — one-time `appUrlOpen` listener registration — lives in
 * `src/app/(app)/_deep-link-router.tsx`, keeping this module free of
 * client-only React imports.
 */

export const OAUTH_COMPLETE_DEEP_LINK_EVENT = "vellum:oauth-complete-deeplink";
export const OAUTH_COMPLETE_DEEP_LINK_HOST = "oauth-complete";

export interface OAuthCompleteDeepLinkPayload {
  requestId: string;
  oauthStatus: string | null;
  oauthProvider: string | null;
  oauthCode: string | null;
}

/**
 * Augments `WindowEventMap` so `window.addEventListener` /
 * `window.dispatchEvent` calls for `OAUTH_COMPLETE_DEEP_LINK_EVENT` are
 * typed with the payload directly, removing the need for callers to cast
 * the incoming `Event` to `CustomEvent<OAuthCompleteDeepLinkPayload>`.
 * Spec: https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent.
 */
declare global {
  interface WindowEventMap {
    "vellum:oauth-complete-deeplink": CustomEvent<OAuthCompleteDeepLinkPayload>;
  }
}

/**
 * Maps the popup-complete page's hostname to the matching iOS
 * `BUNDLE_URL_SCHEME` for that build target. Each iOS build target
 * (App, App-Dev, App-Staging) sets an `ASSOCIATED_DOMAIN` and
 * `BUNDLE_URL_SCHEME` pair in its xcconfig, so this mapping mirrors
 * the native build configuration:
 *
 *   - `web/ios/App/App/Config/App.xcconfig`         (prod)
 *   - `web/ios/App/App/Config/App-Staging.xcconfig` (staging)
 *   - `web/ios/App/App/Config/App-Dev.xcconfig`     (dev)
 *
 * The bare-apex `vellum.ai` entry is an alias of `www.vellum.ai`; both
 * hosts resolve to the same prod `BUNDLE_URL_SCHEME` so requests that
 * land on the apex (e.g. before the apex→www redirect) still produce a
 * valid deep link. Keep these in sync if either the native scheme or
 * an associated domain changes.
 */
const NATIVE_URL_SCHEME_BY_HOST: Record<string, string> = {
  "www.vellum.ai": "vellum-assistant",
  "vellum.ai": "vellum-assistant",
  "staging-assistant.vellum.ai": "vellum-assistant-staging",
  "dev-assistant.vellum.ai": "vellum-assistant-dev",
};

/**
 * Set of schemes that are accepted by `parseOAuthCompleteDeepLink`. Derived
 * directly from `NATIVE_URL_SCHEME_BY_HOST` so a new build target adds its
 * scheme to both the producer (`getNativeUrlSchemeForHost`) and the consumer
 * (`parseOAuthCompleteDeepLink`) at the same time. Stored with the trailing
 * `:` because `URL.protocol` always returns it that way; this is the form we
 * compare against. Spec: https://url.spec.whatwg.org/#dom-url-protocol
 */
const ALLOWED_NATIVE_URL_PROTOCOLS = new Set(
  Object.values(NATIVE_URL_SCHEME_BY_HOST).map((scheme) => `${scheme}:`),
);

export function getNativeUrlSchemeForHost(host: string): string | null {
  return NATIVE_URL_SCHEME_BY_HOST[host] ?? null;
}

export function buildOAuthCompleteDeepLink(
  scheme: string,
  payload: OAuthCompleteDeepLinkPayload,
): string {
  const params = new URLSearchParams();
  params.set("requestId", payload.requestId);
  // Distinguish absent (`null`) from empty-string explicitly so a build is
  // round-trippable through the parser without losing information.
  if (payload.oauthStatus !== null) {
    params.set("oauth_status", payload.oauthStatus);
  }
  if (payload.oauthProvider !== null) {
    params.set("oauth_provider", payload.oauthProvider);
  }
  if (payload.oauthCode !== null) {
    params.set("oauth_code", payload.oauthCode);
  }
  return `${scheme}://${OAUTH_COMPLETE_DEEP_LINK_HOST}?${params.toString()}`;
}

/**
 * Parse a `vellum-assistant://oauth-complete?…` deep link payload.
 * Returns `null` for any URL that is not an OAuth-complete deep link
 * (unrecognised scheme, wrong host, or missing `requestId`). Untrusted
 * inbound URLs from `appUrlOpen` should be filtered through this before
 * being acted on; consumers must additionally verify `requestId`
 * matches an in-flight request to defend against spoofing by other apps
 * registering the same scheme.
 */
export function parseOAuthCompleteDeepLink(
  rawUrl: string,
): OAuthCompleteDeepLinkPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // Exact-match against the allow-list. A `startsWith` check would let
  // unrelated schemes like `vellum-assistant-evil:` or `vellum-assistantx:`
  // through, which an attacker could register on a victim's device to spoof
  // OAuth completions. The scheme alone is not a security boundary (apps can
  // claim arbitrary URL schemes on iOS), so consumers also match on
  // `requestId`, but rejecting unknown schemes here is the cheapest first
  // line of defence.
  if (!ALLOWED_NATIVE_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }

  if (url.host !== OAUTH_COMPLETE_DEEP_LINK_HOST) {
    return null;
  }

  const requestId = url.searchParams.get("requestId");
  if (!requestId) {
    return null;
  }

  return {
    requestId,
    oauthStatus: url.searchParams.get("oauth_status"),
    oauthProvider: url.searchParams.get("oauth_provider"),
    oauthCode: url.searchParams.get("oauth_code"),
  };
}
