import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  assistantsDomainsListOptions,
  assistantsDomainsListQueryKey,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesListQueryKey,
  assistantsListOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import { usePlatformGateWithPending } from "@/hooks/use-platform-gate";
import { useEnvironmentStore } from "@/stores/environment-store";

import { resolveInboxStatus, type InboxStatus } from "../resolve-inbox-status";

export interface AssistantInboxState {
  status: InboxStatus;
  /** The id the platform's assistant routes key on; `null` until resolved. */
  platformAssistantId: string | null;
  /** The assistant as the platform lists it; falls back to the name given. */
  assistantName: string;
  /** The public handle, which is the subdomain of the address. */
  handle: string;
  /** Whether a domain row exists already, so setup knows what to create. */
  hasDomain: boolean;
  /** The registered address, once there is one. */
  address: string | null;
  /** Its platform id, which the usage endpoint keys on. */
  addressId: string | null;
  rootDomain: string;
  /** Re-read the address and domain lists, after setup registers them. */
  refreshAddresses: () => Promise<void>;
}

/**
 * Everything the inbox needs to know to pick a state, read from the caches
 * that own it: the platform gate, the billing subscription's entitlements,
 * the platform's assistant listing (for the handle and name), and the
 * assistant's address and domain lists. Managed email lives on the platform
 * API, whose assistant routes key on the platform UUID, so the local id is
 * resolved to that first; the reads that need it wait on it.
 */
export function useAssistantInboxState(
  assistantId: string | null,
  fallbackName: string,
): AssistantInboxState {
  const queryClient = useQueryClient();
  const gate = usePlatformGateWithPending({ platformHostedOnly: true });
  const onPlatform = gate === "full" && !!assistantId;
  const orgReady = useIsOrgReady();
  const rootDomain = useEnvironmentStore.use.emailRootDomain();

  const { platformAssistantId } = usePlatformAssistantId(
    assistantId,
    onPlatform,
  );

  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: onPlatform && orgReady,
  });
  const entitlements = subscriptionQuery.data?.entitlements as
    | Record<string, unknown>
    | undefined;
  const subscriptionFailed =
    !subscriptionQuery.data &&
    subscriptionQuery.isError &&
    !subscriptionQuery.isFetching;

  const assistantsQuery = useQuery({
    ...assistantsListOptions(),
    enabled: onPlatform && orgReady,
  });
  const listed =
    assistantsQuery.data?.results?.find(
      (candidate) => candidate.id === platformAssistantId,
    ) ?? assistantsQuery.data?.results?.[0];

  const addressPath = { path: { assistant_id: platformAssistantId ?? "" } };
  const readsEnabled =
    onPlatform && orgReady && !!platformAssistantId && !!entitlements
      ? entitlements.managed_email === true
      : onPlatform && orgReady && !!platformAssistantId && subscriptionFailed;

  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions(addressPath),
    enabled: readsEnabled,
  });
  const domainsQuery = useQuery({
    ...assistantsDomainsListOptions(addressPath),
    enabled: readsEnabled,
  });

  const addresses = addressesQuery.data?.results;
  const domain = domainsQuery.data?.results?.[0];

  const refreshAddresses = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: assistantsEmailAddressesListQueryKey(addressPath),
      }),
      queryClient.invalidateQueries({
        queryKey: assistantsDomainsListQueryKey(addressPath),
      }),
    ]);
    // The query key above is built from the id, so a change of assistant
    // rebuilds it; the callback only needs the id itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, platformAssistantId]);

  return {
    status: resolveInboxStatus({
      gate,
      platformAssistantId,
      entitlements,
      subscriptionFailed,
      addressCount: addresses?.length,
      domainsSettled: domainsQuery.isFetched,
    }),
    platformAssistantId,
    assistantName: listed?.name || fallbackName,
    handle: domain?.subdomain ?? listed?.handle ?? "",
    hasDomain: !!domain,
    address: addresses?.[0]?.address ?? null,
    addressId: addresses?.[0]?.id ?? null,
    rootDomain,
    refreshAddresses,
  };
}
