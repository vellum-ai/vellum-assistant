import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useCallSiteDefaultProfile } from "@/hooks/use-call-site-default-profile";
import { useTranslation } from "@/i18n";
import { extractUsageProfileMetadata } from "@/utils/profile-metadata";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import type { ResolvableCallSite } from "@/hooks/use-call-site-default-profile";
import type { UsageProfileMetadataMap } from "@/utils/profile-metadata";

type CallSiteOverride = NonNullable<
  NonNullable<NonNullable<ConfigGetResponse["llm"]>["callSites"]>[string]
>;

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
  fallbackLabel,
  respectCallSiteOverride = false,
}: {
  assistantId: string;
  pinnedProfile?: string | null;
  defaultCallSite?: ResolvableCallSite;
  fallbackLabel?: string;
  respectCallSiteOverride?: boolean;
}) {
  const { t } = useTranslation("settings");
  const resolvedFallback =
    fallbackLabel ?? t("modelProfileRow.defaultMainAgent");

  const callSiteOverrideLabel = (
    override: CallSiteOverride | null | undefined,
    metadata: UsageProfileMetadataMap,
  ) => {
    if (override == null) {
      return undefined;
    }
    if (override.provider != null || override.model != null) {
      return t("modelProfileRow.customCallSiteModel");
    }
    const profile = override.profile?.trim();
    return profile
      ? t("modelProfileRow.override", {
          name: profileDisplayName(profile, metadata),
        })
      : undefined;
  };

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
          ? t("modelProfileRow.defaultNamed", { name: defaultProfileLabel })
          : resolvedFallback;

  return (
    <div className="flex min-h-6 items-center justify-between gap-4">
      <span className="shrink-0 text-[var(--content-secondary)]">
        {t("modelProfileRow.label")}
      </span>
      <span className="min-w-0 truncate text-right" title={profileLabel}>
        {profileLabel}
      </span>
    </div>
  );
}
