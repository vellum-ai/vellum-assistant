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
  // The legacy `provider` field is read-tolerated but never set: older
  // daemons still route on a persisted provider pin, so hiding such an
  // entry would show an unmodified row while dispatch is still changed.
  // The row stays visible and clearable; every write path sends
  // `provider: null`.
  return !!(d.profile || d.model) || d.provider != null;
}

/**
 * The profile a call site currently runs on, and how it got there.
 *
 * The authority is the catalog's `defaultProfile`, which is the daemon's own
 * winning profile for the call site: pins included, and rungs the resolver
 * cannot use already skipped. Reading the raw override instead would report
 * a pin that names a disabled or incomplete profile as the current
 * selection, when the resolver skips it and the action runs on something
 * else entirely.
 *
 * `via` is therefore derived by asking whether the winner is the pin, rather
 * than assuming a pin wins. Returns null for model ("Custom") pins, which
 * reference no profile at all; a legacy provider pin counts too, since old
 * daemons still route on it.
 */
export interface CallSiteEffectiveProfile {
  profile: string;
  via: "override" | "default";
}

/** The catalog fields naming which profile a call site resolves to. */
type CallSiteDefaults = Pick<
  ConfigLlmCallsitesGetResponse["callSites"][number],
  "defaultProfile" | "shippedDefaultProfile"
>;

export function effectiveCallSiteProfile(
  callSite: CallSiteDefaults,
  override: CallSiteOverrideDraft | null | undefined,
): CallSiteEffectiveProfile | null {
  if (override?.model || override?.provider != null) {
    return null;
  }
  // `shippedDefaultProfile` covers the profileless case, where the winner is
  // the code-owned anchor rather than a named profile and `defaultProfile`
  // is absent. It matches what the row caption shows for those sites.
  const winner = callSite.defaultProfile ?? callSite.shippedDefaultProfile;
  if (!winner) {
    return null;
  }
  return {
    profile: winner,
    via: override?.profile === winner ? "override" : "default",
  };
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
    // Legacy provider pins compare too, so replacing one with a model-only
    // pin of the same model still reads as a change worth saving (the save
    // is what clears the pin).
    (a?.provider ?? null) === (b?.provider ?? null) &&
    (a?.model ?? null) === (b?.model ?? null)
  );
}
