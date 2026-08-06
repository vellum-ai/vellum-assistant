import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import { buildOrderedProfiles } from "@/domains/settings/ai/utils";
import { inferenceProfilesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ConfigGetResponse,
  InferenceProfileSummary,
} from "@/generated/daemon/types.gen";
import { useSupportsInferenceProfiles } from "@/lib/backwards-compat/use-supports-inference-profiles";

export interface InferenceProfileList {
  /** Ordered display rows for the Profiles section. */
  entries: InferenceProfileSummary[];
  /**
   * True when `entries` came from `GET /inference/profiles` - the effective
   * catalog with server-resolved models and per-profile availability. False
   * on the legacy fallback derived from the raw config map, where managed
   * rows show their stored (not resolved) model and availability is unknown.
   */
  isEffectiveCatalog: boolean;
}

/**
 * The Profiles section's display list. Prefers the daemon's effective
 * catalog (v0.11.0+); older daemons fall back to the ordered
 * `config.llm.profiles` map projected into the same summary shape.
 */
export function useInferenceProfileList(
  assistantId: string,
  config: ConfigGetResponse | undefined,
): InferenceProfileList {
  const supportsEffectiveCatalog = useSupportsInferenceProfiles();
  const { data: effectiveCatalog } = useQuery({
    ...inferenceProfilesGetOptions({ path: { assistant_id: assistantId } }),
    enabled: supportsEffectiveCatalog,
    staleTime: 30_000,
  });

  // Retain the last non-empty profile map so a transient empty config payload
  // can't blank the fallback list (managed profiles are always seeded, so an
  // empty map is never a steady state).
  const { profiles, profileOrder } = useStickyProfiles(
    config?.llm,
    assistantId,
  );

  return useMemo(() => {
    if (effectiveCatalog != null) {
      return {
        entries: effectiveCatalog.profiles,
        isEffectiveCatalog: true,
      };
    }
    const entries = buildOrderedProfiles(profiles, profileOrder).map(
      (profile): InferenceProfileSummary => ({
        name: profile.name,
        label: profile.label ?? null,
        provider: profile.provider ?? null,
        model: profile.model ?? null,
        status: profile.status === "disabled" ? "disabled" : "active",
        source: profile.source === "managed" ? "managed" : "user",
        provider_connection: profile.provider_connection,
        availability: null,
      }),
    );
    return { entries, isEffectiveCatalog: false };
  }, [effectiveCatalog, profiles, profileOrder]);
}
