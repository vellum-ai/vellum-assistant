/**
 * Pure utilities for the Capacitor OAuth-completion deep link.
 *
 * On Capacitor iOS, integration OAuth runs inside `SFSafariViewController`.
 * Apple's prescribed pattern for round-tripping back into a host app from
 * SFSafariViewController is a custom URL scheme: redirecting
 * `window.location.href = "<scheme>://oauth-complete?…"` causes iOS to
 * dismiss the sheet and route the URL into the registered app via
 * `application(_:open:options:)`. Capacitor surfaces that as the
 * `appUrlOpen` listener event.
 *
 * Reference: https://capacitorjs.com/docs/apis/app#addlistenerappurlopen-
 */

export const OAUTH_COMPLETE_DEEP_LINK_EVENT = "vellum:oauth-complete-deeplink";
export const OAUTH_COMPLETE_DEEP_LINK_HOST = "oauth-complete";

export interface OAuthCompleteDeepLinkPayload {
  requestId: string;
  oauthStatus: string | null;
  oauthProvider: string | null;
  oauthCode: string | null;
}

declare global {
  interface WindowEventMap {
    "vellum:oauth-complete-deeplink": CustomEvent<OAuthCompleteDeepLinkPayload>;
  }
}

/**
 * Maps the popup-complete page's hostname to the matching iOS
 * `BUNDLE_URL_SCHEME` for that build target. Each iOS build target
 * sets an `ASSOCIATED_DOMAIN` and `BUNDLE_URL_SCHEME` pair in its xcconfig.
 */
const NATIVE_URL_SCHEME_BY_HOST: Record<string, string> = {
  "www.vellum.ai": "vellum-assistant",
  "vellum.ai": "vellum-assistant",
  "staging-assistant.vellum.ai": "vellum-assistant-staging",
  "dev-assistant.vellum.ai": "vellum-assistant-dev",
};

const ALLOWED_NATIVE_URL_PROTOCOLS = new Set(
  Object.values(NATIVE_URL_SCHEME_BY_HOST).map((scheme) => `${scheme}:`),
);

export function getNativeUrlSchemeForHost(host: string): string | null {
  return NATIVE_URL_SCHEME_BY_HOST[host] ?? null;
}

export const BILLING_CHECKOUT_COMPLETE_DEEP_LINK_HOST = "billing";
const BILLING_CHECKOUT_COMPLETE_PATH_SEGMENT = "checkout-complete";

/**
 * Stripe Checkout Session id shape (`cs_test_a1B2…` / `cs_live_…`). Mirrors
 * the platform's own check in `checkout_native_return.py` and the macOS main
 * parser, so a malformed id never reaches the billing route.
 */
const CHECKOUT_SESSION_ID_RE = /^cs_[A-Za-z0-9_]{1,255}$/;

export type BillingCheckoutCompleteDeepLinkPayload =
  | { status: "success"; sessionId: string }
  | { status: "cancel"; sessionId: null };

/**
 * Parse a `vellum-assistant://billing/checkout-complete?status=…&session_id=…`
 * deep link, the hand-off the platform bounces a `return_target=native`
 * Checkout to (`checkout_native_return.py`).
 *
 * Returns `null` for anything else — including a `success` without a
 * well-formed Session id, which the app can do nothing with. Semantics mirror
 * the macOS main-process parser so both shells agree.
 */
export function parseBillingCheckoutCompleteDeepLink(
  rawUrl: string,
): BillingCheckoutCompleteDeepLinkPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!ALLOWED_NATIVE_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  if (url.host !== BILLING_CHECKOUT_COMPLETE_DEEP_LINK_HOST) {
    return null;
  }
  const segment = url.pathname.replace(/^\/+/, "").split("/")[0];
  if (segment !== BILLING_CHECKOUT_COMPLETE_PATH_SEGMENT) {
    return null;
  }

  const status = url.searchParams.get("status");
  if (status === "cancel") {
    return { status: "cancel", sessionId: null };
  }
  const sessionId = url.searchParams.get("session_id") ?? "";
  if (status === "success" && CHECKOUT_SESSION_ID_RE.test(sessionId)) {
    return { status: "success", sessionId };
  }
  return null;
}

export function buildOAuthCompleteDeepLink(
  scheme: string,
  payload: OAuthCompleteDeepLinkPayload,
): string {
  const params = new URLSearchParams();
  params.set("requestId", payload.requestId);
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
 * Returns `null` for any URL that is not an OAuth-complete deep link.
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
