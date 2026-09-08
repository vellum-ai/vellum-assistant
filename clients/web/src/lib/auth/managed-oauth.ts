import { assistantsOauthStartCreate } from "@/generated/api/sdk.gen";
import { oauthProvidersGet } from "@/generated/daemon/sdk.gen";
import type { OauthProvidersGetResponses } from "@/generated/daemon/types.gen";
import { extractErrorMessage } from "@/utils/api-errors";
import { routes } from "@/utils/routes";

/**
 * Platform requests behind the managed OAuth connect flow.
 *
 * The flow itself lives in `hooks/use-managed-oauth-connect`, which reads the
 * connections list to decide what happened. These are the requests it needs on
 * the way there.
 */

export type ManagedOAuthProviderSummary =
  OauthProvidersGetResponses[200]["providers"][number];

export type ManagedOAuthErrorReason =
  /** The browser refused the authorization window. */
  | "popup-blocked"
  /** Authorization could not be started, so the provider was never reached. */
  | "start-failed"
  /** The provider returned a failure to the callback. */
  | "authorization-failed";

export interface ManagedOAuthError {
  reason: ManagedOAuthErrorReason;
  /** Provider-supplied failure code, when the callback carried one. */
  code?: string;
  /**
   * The failure's own explanation. Raw error text rather than catalog copy,
   * which is why `managedOAuthErrorMessage` renders it inside a localized
   * frame instead of using it as the sentence.
   */
  detail?: string;
}

export async function fetchManagedOAuthProvider(
  assistantId: string,
  providerKey: string,
): Promise<ManagedOAuthProviderSummary | null> {
  const { data, error } = await oauthProvidersGet({
    path: { assistant_id: assistantId },
    query: { supports_managed_mode: "true" },
    throwOnError: false,
  });
  if (error || !data) {
    return null;
  }
  return (
    data.providers.find(
      (provider) =>
        provider.provider_key === providerKey && provider.supports_managed_mode,
    ) ?? null
  );
}

/**
 * Ask the platform for the provider's authorize URL. `requestId` comes back on
 * the completion page's payload, which is how a completion is matched to the
 * attempt that asked for it.
 */
export async function startManagedOAuth(
  assistantId: string,
  providerKey: string,
  requestId: string,
  native: boolean,
  requestedScopes: string[] | undefined,
): Promise<string> {
  const redirectAfterConnect = `${routes.account.oauth.popupComplete}?requestId=${requestId}${native ? "&native=1" : ""}`;
  const { data, error, response } = await assistantsOauthStartCreate({
    path: { assistant_id: assistantId, provider: providerKey },
    body: {
      requested_scopes: requestedScopes ?? [],
      redirect_after_connect: redirectAfterConnect,
    },
    throwOnError: false,
  });

  if (error || !data?.connect_url) {
    throw new Error(
      extractErrorMessage(error, response, "Failed to start authorization."),
    );
  }

  return data.connect_url;
}
