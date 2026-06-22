import type { UsageCallSiteMetadataMap } from "./call-site-metadata";
import type { UsageProfileMetadataMap } from "@/utils/profile-metadata";
import type {
  UsageGroupBreakdown,
  UsageGroupBy,
} from "./usage-types";

export interface UsageGroupLabelMetadata {
  callSites?: UsageCallSiteMetadataMap;
  profiles?: UsageProfileMetadataMap;
}

export function resolveUsageGroupLabel(
  groupBy: UsageGroupBy,
  group: UsageGroupBreakdown,
  metadata: UsageGroupLabelMetadata,
): string {
  if (groupBy === "task") {
    const groupKey = group.groupKey;
    if (!groupKey) {
      return group.group;
    }

    return metadata.callSites?.[groupKey]?.displayName ?? group.group;
  }

  if (groupBy === "profile") {
    const groupKey = group.groupKey;
    if (!groupKey) {
      return group.group || "Default / Unset";
    }

    return metadata.profiles?.[groupKey]?.displayName ?? group.group;
  }

  return group.group;
}

export function decorateUsageBreakdownGroups(
  groups: UsageGroupBreakdown[],
  groupBy: UsageGroupBy,
  metadata: UsageGroupLabelMetadata,
): UsageGroupBreakdown[] {
  if (!groups || groups.length === 0) {
    return [];
  }

  return groups.map((group) => {
    const resolvedGroup = resolveUsageGroupLabel(groupBy, group, metadata);
    if (resolvedGroup === group.group) {
      return group;
    }

    return {
      ...group,
      group: resolvedGroup,
    };
  });
}
