/**
 * Identity details for the About Assistant pages: the daemon's `/identity`
 * document (name, role, personality) plus the assistant record's creation
 * date ("hatched"). Shared through React Query so the overview and the
 * personality page read one cached result, and identity rewrites (rename,
 * personality update) can invalidate it for every consumer.
 */

import { useQuery } from "@tanstack/react-query";

import { getAssistant } from "@/assistant/api";
import { fetchAssistantIdentity } from "@/assistant/identity";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";

export interface AssistantIdentityDetails {
  identity: IdentityGetResponse | null;
  createdAt: string | null;
}

export function assistantIdentityDetailsQueryKey(assistantId: string) {
  return ["assistant-identity-details", assistantId] as const;
}

export function useAssistantIdentityDetails(assistantId: string) {
  return useQuery<AssistantIdentityDetails>({
    queryKey: assistantIdentityDetailsQueryKey(assistantId),
    queryFn: async () => {
      const [identity, assistantResult] = await Promise.all([
        fetchAssistantIdentity(assistantId),
        getAssistant(assistantId).catch(
          () => ({ ok: false as const, status: 0, error: {} }),
        ),
      ]);
      return {
        identity,
        createdAt: assistantResult.ok ? assistantResult.data.created : null,
      };
    },
  });
}
