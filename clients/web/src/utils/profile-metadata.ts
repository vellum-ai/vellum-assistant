/**
 * Derives inference-profile display metadata from the daemon config response.
 * Used as a TanStack Query `select` transform on `configGetOptions()`.
 */

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

export interface UsageProfileMetadata {
  id: string;
  displayName: string;
  description?: string;
}

export type UsageProfileMetadataMap = Record<string, UsageProfileMetadata>;

export function extractUsageProfileMetadata(
  config: ConfigGetResponse,
): UsageProfileMetadataMap {
  const profiles = config.llm?.profiles;
  if (!profiles) {
    return {};
  }

  const metadata: UsageProfileMetadataMap = {};
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile) {
      continue;
    }

    const displayName = profile.label?.trim() || id;
    const description = profile.description?.trim() || undefined;
    metadata[id] = {
      id,
      displayName,
      ...(description ? { description } : {}),
    };
  }

  return metadata;
}
