import { useQuery } from "@tanstack/react-query";

import {
  assistantsActiveRetrieveOptions,
  assistantsDomainsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";

/**
 * The active assistant and its registered email domains — the single source
 * for "does the assistant have a domain yet", shared by the onboarding
 * wizard's domain step and the billing page's finish-setup nudge so the two
 * can't drift apart.
 */
export function useAssistantDomains(enabled = true) {
  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled,
  });
  const assistantId = activeAssistant?.id;
  const { data: domains } = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: enabled && !!assistantId,
  });
  return { activeAssistant, assistantId, domains };
}
