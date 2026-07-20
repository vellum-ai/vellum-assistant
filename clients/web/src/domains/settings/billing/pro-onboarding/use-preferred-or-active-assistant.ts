import { useQuery } from "@tanstack/react-query";

import {
  assistantsActiveRetrieveOptions,
  assistantsRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type { Assistant } from "@/generated/api/types.gen";

/**
 * The assistant the pro-onboarding flow is acting on: the preferred assistant
 * (the onboarding payload's provisioning target) fetched by id when named,
 * else the active assistant.
 */
export function usePreferredOrActiveAssistant(
  preferredAssistantId?: string | null,
  enabled = true,
): Assistant | undefined {
  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: enabled && preferredAssistantId == null,
  });
  const { data: preferredAssistant } = useQuery({
    ...assistantsRetrieveOptions({ path: { id: preferredAssistantId ?? "" } }),
    enabled: enabled && preferredAssistantId != null,
  });
  return preferredAssistantId != null ? preferredAssistant : activeAssistant;
}
