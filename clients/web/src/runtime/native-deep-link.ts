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
