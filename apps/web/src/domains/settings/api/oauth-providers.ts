import { buildVellumHeaders } from "@/lib/auth/request-headers";

/** Provider summary returned by the runtime catalog endpoint. */
export interface OAuthProviderSummary {
  provider_key: string;
  display_name: string | null;
  description: string | null;
  logo_url: string | null;
  supports_managed_mode: boolean;
}

interface OAuthProviderCatalogResponse {
  providers: OAuthProviderSummary[];
}

/**
 * Fetch the provider catalog for an assistant via the wildcard runtime proxy.
 *
 * The wildcard proxy is excluded from OpenAPI so the generated client can't
 * support this endpoint — hence the hand-written fetch wrapper.
 */
export async function fetchOAuthProviders(
  assistantId: string,
): Promise<OAuthProviderSummary[]> {
  const res = await fetch(`/v1/assistants/${assistantId}/oauth/providers/`, {
    headers: buildVellumHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch OAuth providers (HTTP ${res.status})`);
  }
  const data: OAuthProviderCatalogResponse = await res.json();
  return data.providers ?? [];
}
