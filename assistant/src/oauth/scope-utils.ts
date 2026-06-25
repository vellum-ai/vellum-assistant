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

const GMAIL_FULL_ACCESS_SCOPE = "https://mail.google.com/";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function grantedScopeCoversRequiredScope(
  grantedScope: string,
  requiredScope: string,
): boolean {
  if (grantedScope === requiredScope) return true;
  return (
    grantedScope === GMAIL_FULL_ACCESS_SCOPE &&
    requiredScope === GMAIL_READONLY_SCOPE
  );
}
