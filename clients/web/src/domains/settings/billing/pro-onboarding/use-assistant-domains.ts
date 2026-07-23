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
  const { data: domains, isError: domainsError } = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: enabled && !!assistantId,
  });
  return { assistant, assistantId, domains, domainsError };
}
