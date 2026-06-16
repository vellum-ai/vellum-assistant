/**
 * Types and transforms for the daemon's LLM call-site catalog.
 * Used as a TanStack Query `select` transform or inline `buildCallSiteMetadataMap`
 * on `configLlmCallsitesGetOptions()`.
 */

import type { ConfigLlmCallsitesGetResponse } from "@/generated/daemon/types.gen";

export interface UsageCallSiteMetadata {
  id: string;
  displayName: string;
  description: string;
  domain: string;
}

export type UsageCallSiteMetadataMap = Record<string, UsageCallSiteMetadata>;

export function buildCallSiteMetadataMap(
  catalog: ConfigLlmCallsitesGetResponse | null | undefined,
): UsageCallSiteMetadataMap {
  if (!catalog) {
    return {};
  }

  const map: UsageCallSiteMetadataMap = {};
  for (const callSite of catalog.callSites) {
    if (!callSite.id || !callSite.displayName) {
      continue;
    }

    map[callSite.id] = {
      id: callSite.id,
      displayName: callSite.displayName,
      description: callSite.description,
      domain: callSite.domain,
    };
  }

  return map;
}
