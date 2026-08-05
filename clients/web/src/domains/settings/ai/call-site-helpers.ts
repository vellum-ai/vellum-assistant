import type { CallSiteOverrideDraft } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Sentinel value for the "Custom" profile picker option
// ---------------------------------------------------------------------------

export const CUSTOM_SENTINEL = "__custom__";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isDraftActive(
  d: CallSiteOverrideDraft | null | undefined,
): boolean {
  if (!d) {
    return false;
  }
  return !!(d.profile || d.provider || d.model);
}

/**
 * The profile a call site currently runs on, and how it got there: an
 * explicit profile override, or the site's default profile when nothing
 * pins it. Returns null for provider/model ("Custom") pins, which
 * reference no profile, and for sites with no resolvable default.
 */
export interface CallSiteEffectiveProfile {
  profile: string;
  via: "override" | "default";
}

export function effectiveCallSiteProfile(
  defaultProfile: string | null | undefined,
  override: CallSiteOverrideDraft | null | undefined,
): CallSiteEffectiveProfile | null {
  if (override?.provider || override?.model) {
    return null;
  }
  if (override?.profile) {
    return { profile: override.profile, via: "override" };
  }
  if (defaultProfile) {
    return { profile: defaultProfile, via: "default" };
  }
  return null;
}

export function draftsEqual(
  a: CallSiteOverrideDraft | null | undefined,
  b: CallSiteOverrideDraft | null | undefined,
): boolean {
  const aActive = isDraftActive(a);
  const bActive = isDraftActive(b);
  if (aActive !== bActive) {
    return false;
  }
  if (!aActive) {
    return true;
  }
  return (
    (a?.profile ?? null) === (b?.profile ?? null) &&
    (a?.provider ?? null) === (b?.provider ?? null) &&
    (a?.model ?? null) === (b?.model ?? null)
  );
}
