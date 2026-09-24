/**
 * Public URL resolution for the assistant's shared OAuth callback route.
 *
 * Every browser-based OAuth flow in the daemon redirects back to one path,
 * `webhooks/oauth/callback`, which the gateway serves and forwards to
 * `POST /v1/internal/oauth/callback`. The runtime matches the arriving
 * `state` against `security/oauth-callback-registry.ts` and resolves the
 * waiting flow, so one route multiplexes every concurrent handshake and no
 * caller needs a listener of its own.
 *
 * Which base URL is correct depends on how the assistant is reachable: a
 * platform pod and a platform-connected assistant are served through a
 * managed callback route, a self-hosted deployment through its configured
 * public ingress. `resolveCallbackUrl` owns that decision, and this is the
 * OAuth-shaped entry point to it, mirroring `plugin-api/webhook-url.ts`
 * for plugin ingress.
 */

import { loadConfig } from "../config/loader.js";
import { resolveCallbackUrl } from "./platform-callback-registration.js";
import {
  getMcpOAuthClientMetadataUrl,
  getOAuthCallbackUrl,
} from "./public-ingress-urls.js";

/**
 * Path the gateway serves the shared OAuth callback on.
 *
 * Fixed rather than caller-supplied. Every flow is demultiplexed by OAuth
 * `state`, so a per-caller path would buy nothing and would need its own
 * gateway route and its own platform registration.
 */
export const OAUTH_CALLBACK_PATH = "webhooks/oauth/callback";

/**
 * Registration type recorded with the platform.
 *
 * The platform keys a callback route by `(path, type)`, and there is one
 * OAuth route, so one type describes it. Registering the same path under
 * several types would produce duplicate admin rows pointing at the same
 * URL.
 */
const OAUTH_REGISTRATION_TYPE = "oauth";

/**
 * Resolve the redirect URI an authorization server should send the user
 * back to.
 *
 * Takes no arguments on purpose: every caller shares one route, so there
 * is nothing to vary. That is what makes the URI stable across callers and
 * across attempts, which is what an exact-match `redirect_uri` check needs.
 *
 * @throws when no public ingress is configured and the assistant is not
 *   connected to the platform. There is no URL that would work in that
 *   case, and returning a plausible one produces an authorization request
 *   whose callback silently never arrives.
 */
export async function resolveOauthCallbackUrl(): Promise<string> {
  return resolveCallbackUrl(
    () => getOAuthCallbackUrl(loadConfig()),
    OAUTH_CALLBACK_PATH,
    OAUTH_REGISTRATION_TYPE,
  );
}

/**
 * Return the public Client ID Metadata Document URL when it is compatible
 * with the callback selected for this flow.
 *
 * A URL-based client id must be HTTPS, and its document must publish the exact
 * redirect URI used by the authorization request. The gateway document is
 * derived from public ingress, so a platform-relayed callback cannot use it.
 * Returning undefined preserves Dynamic Client Registration as the SDK's
 * fallback in either case.
 */
export function resolveMcpOAuthClientMetadataUrl(
  redirectUrl: string,
): string | undefined {
  try {
    const config = loadConfig();
    if (getOAuthCallbackUrl(config) !== redirectUrl) {
      return undefined;
    }

    const metadataUrl = getMcpOAuthClientMetadataUrl(config);
    return new URL(metadataUrl).protocol === "https:" ? metadataUrl : undefined;
  } catch {
    return undefined;
  }
}
