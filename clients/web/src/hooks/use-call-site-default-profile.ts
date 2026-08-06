import { useQuery } from "@tanstack/react-query";

import {
  configGetOptions,
  configLlmCallsitesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { extractUsageProfileMetadata } from "@/utils/profile-metadata";

/** LLM call sites whose default profile the UI resolves for display. */
export type ResolvableCallSite =
  | "mainAgent"
  | "heartbeatAgent"
  | "memoryV2Consolidation"
  | "memoryRetrospective";

export interface CallSiteDefaultProfile {
  /**
   * Inference profile key the call site resolves to when nothing pins it, or
   * null when the winner is the code-owned anchor rather than a named profile.
   */
  key: string | null;
  /** Display label for `key`, or null when there is no named profile. */
  label: string | null;
}

/**
 * The inference profile a call site falls back to, as the daemon resolves it.
 *
 * The catalog endpoint runs the same `resolveDefaultProfileKey` the daemon uses
 * when it pins a new schedule, so this is the one answer to "which profile
 * would this run on if nobody chose". Reading it from the catalog rather than
 * re-deriving the precedence chain client-side is what keeps the label the user
 * sees and the profile a schedule is pinned to from drifting apart.
 */
export function useCallSiteDefaultProfile(
  assistantId: string,
  callSite: ResolvableCallSite,
  options?: { enabled?: boolean },
): CallSiteDefaultProfile {
  const enabled = Boolean(assistantId) && options?.enabled !== false;
  const { data: catalog } = useQuery({
    ...configLlmCallsitesGetOptions({ path: { assistant_id: assistantId } }),
    enabled,
    staleTime: 60_000,
  });
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled,
    staleTime: 60_000,
  });

  const key =
    catalog?.callSites.find((entry) => entry.id === callSite)?.defaultProfile ??
    null;
  if (key == null) {
    return { key: null, label: null };
  }
  const metadata = daemonConfig
    ? extractUsageProfileMetadata(daemonConfig)
    : {};
  return { key, label: metadata[key]?.displayName ?? key };
}
