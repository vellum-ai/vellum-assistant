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

/** Subset of the full provider detail response that the web UI consumes. */
export interface OAuthProviderDetail {
  oauth_callback_url: string | null;
}

interface OAuthProviderDetailResponse {
  provider: Record<string, unknown>;
  oauth_callback_url: string | null;
}

export async function fetchOAuthProviderDetail(
  assistantId: string,
  providerKey: string,
): Promise<OAuthProviderDetail> {
  const res = await fetch(
    `/v1/assistants/${assistantId}/oauth/providers/${encodeURIComponent(providerKey)}`,
    { headers: buildVellumHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch OAuth provider detail (HTTP ${res.status})`);
  }
  const data: OAuthProviderDetailResponse = await res.json();
  return { oauth_callback_url: data.oauth_callback_url ?? null };
}
