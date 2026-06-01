/**
 * Fetch wrapper for the daemon's LLM call-site catalog endpoint.
 * Consumes the generated daemon SDK; the catalog response type is derived
 * from the route's declared schema.
 */

import { configLlmCallsitesGet } from "@/generated/daemon/sdk.gen";

/**
 * Hand-written response shape for the LLM call-site catalog endpoint.
 * The generated type is `200: unknown` — the daemon route doesn't yet
 * declare a response schema.
 */
interface CallSiteCatalogResponse {
  domains: Array<{ id: string; displayName: string }>;
  callSites: Array<{
    id: string;
    displayName: string;
    description: string;
    domain: string;
  }>;
}

export interface UsageCallSiteMetadata {
  id: string;
  displayName: string;
  description: string;
  domain: string;
}

export type UsageCallSiteMetadataMap = Record<string, UsageCallSiteMetadata>;

export function buildCallSiteMetadataMap(
  catalog: CallSiteCatalogResponse | null | undefined,
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

export async function fetchUsageCallSiteCatalog(
  assistantId: string,
): Promise<CallSiteCatalogResponse> {
  const { data, response } = await configLlmCallsitesGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!response?.ok) {
    const text = await response
      ?.clone()
      .text()
      .catch(() => "");
    throw new Error(
      text || response?.statusText || "Failed to load LLM call-site metadata.",
    );
  }
  return (data as CallSiteCatalogResponse | undefined) ?? { domains: [], callSites: [] };
}
