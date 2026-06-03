import { oauthProvidersGet } from "@/generated/daemon/sdk.gen";
import type { OauthProvidersGetResponses } from "@/generated/daemon/types.gen";
import { buildVellumHeaders } from "@/lib/auth/request-headers";

/** Provider summary returned by the runtime catalog endpoint. */
export type OAuthProviderSummary =
  OauthProvidersGetResponses[200]["providers"][number];

/** Fetch the provider catalog for an assistant. */
export async function fetchOAuthProviders(
  assistantId: string,
): Promise<OAuthProviderSummary[]> {
  const { data, error } = await oauthProvidersGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error("Failed to fetch OAuth providers");
  }
  return data.providers;
}

/** Subset of the full provider detail response that the web UI consumes. */
export interface OAuthProviderDetail {
  oauth_callback_url: string | null;
}

interface OAuthProviderDetailResponse {
  provider: Record<string, unknown>;
  oauth_callback_url: string | null;
}

/**
 * Fetch a single provider's detail. The detail route returns the full provider
 * configuration as an open-ended object, so this reads through a raw fetch and
 * projects out only the callback URL the web UI consumes.
 */
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
