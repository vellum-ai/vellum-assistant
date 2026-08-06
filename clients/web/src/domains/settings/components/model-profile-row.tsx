import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useCallSiteDefaultProfile } from "@/hooks/use-call-site-default-profile";
import { extractUsageProfileMetadata } from "@/utils/profile-metadata";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import type { ResolvableCallSite } from "@/hooks/use-call-site-default-profile";
import type { UsageProfileMetadataMap } from "@/utils/profile-metadata";

const DEFAULT_MAIN_AGENT_PROFILE_LABEL = "Default (assistant's main model)";
const CUSTOM_CALL_SITE_MODEL_LABEL = "Custom call-site model";

type CallSiteOverride = NonNullable<
  NonNullable<NonNullable<ConfigGetResponse["llm"]>["callSites"]>[string]
>;

function profileDisplayName(
  profileKey: string,
  metadata: UsageProfileMetadataMap | undefined,
) {
  return metadata?.[profileKey]?.displayName ?? profileKey;
}

function callSiteOverrideLabel(
  override: CallSiteOverride | null | undefined,
  metadata: UsageProfileMetadataMap,
) {
  if (override == null) {
    return undefined;
  }
  if (override.provider != null || override.model != null) {
    return CUSTOM_CALL_SITE_MODEL_LABEL;
  }
  const profile = override.profile?.trim();
  return profile
    ? `Override (${profileDisplayName(profile, metadata)})`
    : undefined;
}

export function ModelProfileRow({
  assistantId,
  pinnedProfile,
  defaultCallSite = "mainAgent",
  fallbackLabel = DEFAULT_MAIN_AGENT_PROFILE_LABEL,
  respectCallSiteOverride = false,
}: {
  assistantId: string;
  pinnedProfile?: string | null;
  defaultCallSite?: ResolvableCallSite;
  fallbackLabel?: string;
  respectCallSiteOverride?: boolean;
}) {
  const shouldResolveDefault = pinnedProfile == null;
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });
  const profileMetadata = useMemo(
    () => (daemonConfig ? extractUsageProfileMetadata(daemonConfig) : {}),
    [daemonConfig],
  );
  const { label: defaultProfileLabel } = useCallSiteDefaultProfile(
    assistantId,
    defaultCallSite,
    { enabled: shouldResolveDefault },
  );

  const overrideLabel =
    shouldResolveDefault && respectCallSiteOverride
      ? callSiteOverrideLabel(
          daemonConfig?.llm?.callSites?.[defaultCallSite],
          profileMetadata,
        )
      : undefined;
  const profileLabel =
    pinnedProfile != null
      ? profileDisplayName(pinnedProfile, profileMetadata)
      : overrideLabel != null
        ? overrideLabel
        : defaultProfileLabel != null
          ? `Default (${defaultProfileLabel})`
          : fallbackLabel;

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[var(--content-secondary)]">Model profile</span>
      <span className="min-w-0 text-right">{profileLabel}</span>
    </div>
  );
}
