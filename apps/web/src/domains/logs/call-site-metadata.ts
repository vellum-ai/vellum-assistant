/**
 * Hand-written fetch wrapper for the daemon's LLM call-site catalog endpoint.
 * Served via RuntimeProxyWildcardView — not in the Django OpenAPI schema.
 */

import { client } from "@/generated/api/client.gen";

export interface UsageCallSiteDomainMetadata {
  id: string;
  displayName: string;
}

export interface UsageCallSiteMetadata {
  id: string;
  displayName: string;
  description: string;
  domain: string;
}

export interface UsageCallSiteCatalogResponse {
  domains: UsageCallSiteDomainMetadata[];
  callSites: UsageCallSiteMetadata[];
}

export type UsageCallSiteMetadataMap = Record<string, UsageCallSiteMetadata>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildCallSiteMetadataMap(
  catalog: UsageCallSiteCatalogResponse | null | undefined,
): UsageCallSiteMetadataMap {
  if (!catalog) {
    return {};
  }

  const map: UsageCallSiteMetadataMap = {};
  const callSites = Array.isArray(catalog.callSites) ? catalog.callSites : [];
  for (const callSite of callSites) {
    if (
      !isNonEmptyString(callSite.id) ||
      !isNonEmptyString(callSite.displayName)
    ) {
      continue;
    }

    map[callSite.id] = {
      id: callSite.id,
      displayName: callSite.displayName,
      description: stringOrEmpty(callSite.description),
      domain: stringOrEmpty(callSite.domain),
    };
  }

  return map;
}

export async function fetchUsageCallSiteCatalog(
  assistantId: string,
): Promise<UsageCallSiteCatalogResponse> {
  const { data, response } = await client.get<UsageCallSiteCatalogResponse>({
    url: "/v1/assistants/{assistant_id}/config/llm/call-sites",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!response || !response.ok) {
    const text = await response
      ?.clone()
      .text()
      .catch(() => "");
    throw new Error(
      text || response?.statusText || "Failed to load LLM call-site metadata.",
    );
  }
  return data ?? { domains: [], callSites: [] };
}
