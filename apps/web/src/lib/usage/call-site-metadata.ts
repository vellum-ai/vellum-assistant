// Hand-written fetch wrapper intentionally — this endpoint is served by the
// assistant runtime proxy and is not part of the Django OpenAPI schema.
import { client } from "@/generated/api/client.gen.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api/errors.js";

import "@/lib/vellum-api/client.js";

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

export { ApiError };

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

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
  const { data, error, response } = await client.get<
    UsageCallSiteCatalogResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/config/llm/call-sites",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to load LLM call-site metadata.",
  );
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to load LLM call-site metadata.",
      ),
    );
  }
  return data ?? { domains: [], callSites: [] };
}
