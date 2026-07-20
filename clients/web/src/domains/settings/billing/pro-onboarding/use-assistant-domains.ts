import { useQuery } from "@tanstack/react-query";

import {
  assistantsActiveRetrieveOptions,
  assistantsDomainsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";

/**
 * The assistant targeted by domain setup and its registered email domains —
 * the single source for "does the assistant have a domain yet", shared by the
 * onboarding wizard's domain step and the billing page's finish-setup nudge
 * so the two can't drift apart.
 *
 * `preferredAssistantId` (the onboarding payload's `primary_assistant_id`)
 * wins over the active assistant when the two diverge (multi-assistant orgs).
 */
export function useAssistantDomains(
  enabled = true,
  preferredAssistantId?: string | null,
) {
  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled,
  });
  const assistantId = preferredAssistantId ?? activeAssistant?.id;
  const { data: domains } = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: enabled && !!assistantId,
  });
  return { activeAssistant, assistantId, domains };
}
