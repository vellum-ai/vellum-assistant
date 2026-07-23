import { useQuery } from "@tanstack/react-query";

import { assistantsDomainsListOptions } from "@/generated/api/@tanstack/react-query.gen";

import { usePreferredOrActiveAssistant } from "./use-preferred-or-active-assistant";

/**
 * The assistant targeted by domain setup and its registered email domains —
 * the single source for "does the assistant have a domain yet", shared by the
 * onboarding wizard's domain step and the billing page's finish-setup nudge
 * so the two can't drift apart.
 *
 * `preferredAssistantId` (the onboarding payload's `primary_assistant_id`)
 * wins over the active assistant when the two diverge (multi-assistant orgs).
 * The returned `assistant` is resolved by the same preference so it always
 * matches the domains being read.
 */
export function useAssistantDomains(
  enabled = true,
  preferredAssistantId?: string | null,
) {
  const assistant = usePreferredOrActiveAssistant(preferredAssistantId, enabled);
  const assistantId = preferredAssistantId ?? assistant?.id;
  const {
    data: domains,
    isError: domainsError,
    // Freshness signals so a caller can tell "stale cache still refetching"
    // from "a response fetched for this view". `domains` being defined is not
    // enough — the shared list has a staleTime, so a cache hit resolves it
    // immediately while a refetch is still in flight. `errorUpdatedAt` lets a
    // caller fence a cached error the same way `dataUpdatedAt` fences cached
    // data, so a pre-view failed refetch can't read as freshly answered. Purely
    // additive; existing callers ignore these.
    isFetching: domainsFetching,
    dataUpdatedAt: domainsUpdatedAt,
    errorUpdatedAt: domainsErrorUpdatedAt,
  } = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: enabled && !!assistantId,
  });
  return {
    assistant,
    assistantId,
    domains,
    domainsError,
    domainsFetching,
    domainsUpdatedAt,
    domainsErrorUpdatedAt,
  };
}
