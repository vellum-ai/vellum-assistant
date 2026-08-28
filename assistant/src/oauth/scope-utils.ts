/**
 * Shared helpers for reasoning about OAuth scope coverage.
 *
 * A single provider key can bundle several products behind one OAuth app
 * (notably Google: Gmail + Calendar + Drive + Contacts). A connection may be
 * granted only a subset of those scopes, so callers that need a specific
 * capability must compare what they require against what was actually granted
 * rather than treating any active connection as fully capable.
 */

/**
 * Return the required scopes that are NOT present in the granted set.
 * An empty result means every required scope is granted.
 */
export function scopeDifference(
  required: string[],
  granted: string[],
): string[] {
  return required.filter(
    (requiredScope) =>
      !granted.some((grantedScope) =>
        grantedScopeCoversRequiredScope(grantedScope, requiredScope),
      ),
  );
}

/**
 * Scope list as a provider writes it: space separated, comma separated, or a
 * mix. Token responses and authorize parameters both arrive in either form.
 */
export function parseScopeList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * The scopes the stored access token is expected to carry.
 *
 * A provider that asks for user scopes alongside bot scopes issues two grants
 * from one authorization. `exchangeCodeForTokens` stores the `authed_user`
 * token in that case and records that token's own grant as `grantedScopes`, so
 * coverage has to be measured against the request that produced the stored
 * token: `user_scope` where the provider sends one, the `scope` parameter
 * otherwise. Measuring a user grant against the bot request reports scopes the
 * authorization could never place on that token.
 */
export function expectedScopesForStoredToken(
  defaultScopes: string[],
  authorizeParams: Record<string, string> | undefined,
): string[] {
  const userScope = authorizeParams?.user_scope;
  if (typeof userScope !== "string") {
    return defaultScopes;
  }
  const parsed = parseScopeList(userScope);
  return parsed.length > 0 ? parsed : defaultScopes;
}

const GMAIL_FULL_ACCESS_SCOPE = "https://mail.google.com/";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function grantedScopeCoversRequiredScope(
  grantedScope: string,
  requiredScope: string,
): boolean {
  if (grantedScope === requiredScope) {
    return true;
  }
  return (
    grantedScope === GMAIL_FULL_ACCESS_SCOPE &&
    requiredScope === GMAIL_READONLY_SCOPE
  );
}
