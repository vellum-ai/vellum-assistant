import { useQuery } from "@tanstack/react-query";

import { fetchScheduleCallSiteCatalog } from "@/domains/settings/api/model-profile";
import { fetchUsageProfileMetadata } from "@/utils/profile-metadata";

import type { UsageProfileMetadataMap } from "@/utils/profile-metadata";

export type ScheduleModelProfileCallSite =
  | "mainAgent"
  | "heartbeatAgent"
  | "memoryV2Consolidation"
  | "memoryRetrospective";

const DEFAULT_MAIN_AGENT_PROFILE_LABEL = "Default (assistant's main model)";

function profileDisplayName(
  profileKey: string,
  metadata: UsageProfileMetadataMap | undefined,
) {
  return metadata?.[profileKey]?.displayName ?? profileKey;
}

export function ModelProfileRow({
  assistantId,
  pinnedProfile,
  defaultCallSite = "mainAgent",
  fallbackLabel = DEFAULT_MAIN_AGENT_PROFILE_LABEL,
}: {
  assistantId: string;
  pinnedProfile?: string | null;
  defaultCallSite?: ScheduleModelProfileCallSite;
  fallbackLabel?: string;
}) {
  const shouldResolveDefault = pinnedProfile == null;
  const { data: profileMetadata } = useQuery({
    queryKey: ["usage-profile-metadata", assistantId],
    queryFn: () => fetchUsageProfileMetadata(assistantId),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });
  const { data: callSiteCatalog } = useQuery({
    queryKey: ["schedule-call-site-catalog", assistantId],
    queryFn: () => fetchScheduleCallSiteCatalog(assistantId),
    enabled: Boolean(assistantId) && shouldResolveDefault,
    staleTime: 60_000,
  });

  const defaultProfile = shouldResolveDefault
    ? callSiteCatalog?.callSites.find(
        (callSite) => callSite.id === defaultCallSite,
      )?.defaultProfile
    : undefined;
  const profileLabel =
    pinnedProfile != null
      ? profileDisplayName(pinnedProfile, profileMetadata)
      : defaultProfile != null
        ? `Default (${profileDisplayName(defaultProfile, profileMetadata)})`
        : fallbackLabel;

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[var(--content-secondary)]">Model profile</span>
      <span className="min-w-0 text-right">{profileLabel}</span>
    </div>
  );
}
