import type { OrgHeaderReadiness } from "@/hooks/use-is-org-ready";

/**
 * Whether every fetch behind a speech capability has concluded, or was never
 * going to run.
 *
 * The `available` flags these hooks expose read false both while an answer is
 * in flight and once it has arrived as no, so a caller showing one thing per
 * outcome needs this to tell those apart.
 *
 * A query's `isLoading` is false when it is disabled or has failed, which is
 * what lets the states that never produce a control (no assistant, an org that
 * resolved to nothing, an old daemon omitting the capability) settle rather
 * than read as perpetually loading. `"resolving"` is the one wait not
 * expressed as a query: it disables all of them, so they would otherwise look
 * settled.
 */
export function isCapabilitySettled(
  orgReadiness: OrgHeaderReadiness,
  ...loading: boolean[]
): boolean {
  return orgReadiness !== "resolving" && !loading.some(Boolean);
}
