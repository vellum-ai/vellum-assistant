/**
 * Remap a host-absolute provider path onto the OAuth passthrough prefix that
 * a minted grant opens.
 *
 * `assistant oauth proxy-url` prints a path-prefixed base
 * (`/v1/oauth/proxy/<segment>`). Stock clients resolve a path that starts
 * with `/` against the origin, not that prefix, so `/upload/gmail/...` or
 * `/v1/charges` leaves the passthrough and the daemon has no handler for it.
 * The grant already names one provider (and account, when pinned). Prefixing
 * the caller's path with that segment is the same request the CLI would have
 * made by concatenating onto the printed base.
 */

import { parseSub } from "../../auth/subject.js";

/** Conversation component minted by `oauth_proxy_grant`. */
const OAUTH_PROXY_SUBJECT_PREFIX = "oauth-proxy.";

/**
 * A path that is already under some `/v1/oauth/proxy/<segment>` prefix.
 * The daemon re-derives the grant subject from that segment, so a rewritten
 * request must not change an already-prefixed path (including one naming a
 * different provider).
 */
const ALREADY_PROXIED_PATH = /^\/v1\/oauth\/proxy\/[^/]+(?:\/|$)/;

/**
 * Provider segment encoded in a grant subject (`google`, or
 * `google@user%40example.com` when the grant pinned an account). Null when
 * the subject is not a passthrough grant.
 */
export function oauthProxySegmentFromSubject(subject: string): string | null {
  const parsed = parseSub(subject);
  if (!parsed.ok || parsed.principalType !== "local") {
    return null;
  }
  const conversationId = parsed.conversationId ?? "";
  if (!conversationId.startsWith(OAUTH_PROXY_SUBJECT_PREFIX)) {
    return null;
  }
  const segment = conversationId.slice(OAUTH_PROXY_SUBJECT_PREFIX.length);
  return segment.length > 0 ? segment : null;
}

/**
 * Upstream pathname the daemon passthrough should see for this grant.
 *
 * Already-proxied paths are left alone. Every other absolute path is prefixed
 * with `/v1/oauth/proxy/<segment>`. Traversal and `//host` stay in the
 * remainder so the daemon's existing `normalizeProxyPath` rejection still
 * applies.
 */
export function rewriteOAuthProxyUpstreamPath(
  pathname: string,
  subject: string,
): string {
  const segment = oauthProxySegmentFromSubject(subject);
  if (!segment) {
    return pathname;
  }
  if (ALREADY_PROXIED_PATH.test(pathname)) {
    return pathname;
  }
  if (!pathname.startsWith("/")) {
    return pathname;
  }
  return `/v1/oauth/proxy/${segment}${pathname}`;
}
