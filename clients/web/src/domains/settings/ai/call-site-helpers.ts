import type {
  CallSiteOverrideDraft,
  ConfigLlmCallsitesGetResponse,
} from "@/generated/daemon/types.gen";

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

/**
 * The catalog fields naming a call site's default, in the order they are
 * consulted. `shippedDefaultProfile` is the code-owned tier and is what the
 * row caption shows, including for profileless sites the daemon reports as
 * Balanced-tier; `defaultProfile` is the effective winner and covers
 * assistants predating the shipped field.
 */
type CallSiteDefaults = Pick<
  ConfigLlmCallsitesGetResponse["callSites"][number],
  "defaultProfile" | "shippedDefaultProfile"
>;

export function effectiveCallSiteProfile(
  callSite: CallSiteDefaults,
  override: CallSiteOverrideDraft | null | undefined,
): CallSiteEffectiveProfile | null {
  if (override?.provider || override?.model) {
    return null;
  }
  if (override?.profile) {
    return { profile: override.profile, via: "override" };
  }
  const fallback = callSite.shippedDefaultProfile ?? callSite.defaultProfile;
  return fallback ? { profile: fallback, via: "default" } : null;
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
