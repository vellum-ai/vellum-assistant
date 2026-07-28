/**
 * The (user, organization) identity a platform response was produced for.
 *
 * The platform evaluates per-request state against this pair — feature flags
 * most visibly, since the LaunchDarkly context is the signed-in user + org, or
 * an anonymous context when there is no session, and the two evaluations
 * legitimately differ. Anything that caches or stores a platform response keys
 * it by this string so a value fetched for one identity is never read as the
 * answer for another.
 */
export function requestScopeKey(input: {
  isAuthenticated: boolean;
  userId: string | null | undefined;
  organizationId: string | null | undefined;
}): string {
  const identity = input.isAuthenticated
    ? `user:${input.userId ?? "unknown"}`
    : "anonymous";
  return `${identity}:org:${input.organizationId ?? "none"}`;
}
