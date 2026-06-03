import {
  oauthProvidersByProviderKeyGet,
  oauthProvidersGet,
} from "@/generated/daemon/sdk.gen";
import type { OauthProvidersGetResponses } from "@/generated/daemon/types.gen";

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

/**
 * Fetch a single provider's detail and project out the ingress callback URL the
 * web UI consumes. The detail route also returns the full provider config as an
 * open-ended object, which this layer intentionally ignores.
 */
export async function fetchOAuthProviderDetail(
  assistantId: string,
  providerKey: string,
): Promise<OAuthProviderDetail> {
  const { data, error } = await oauthProvidersByProviderKeyGet({
    path: { assistant_id: assistantId, providerKey },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error("Failed to fetch OAuth provider detail");
  }
  return { oauth_callback_url: data.oauth_callback_url ?? null };
}
