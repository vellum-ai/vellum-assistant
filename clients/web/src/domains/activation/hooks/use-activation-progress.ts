/**
 * The daemon's activation progress, read once per client and kept fresh by the
 * `activation:progress` sync tag.
 *
 * Progress is daemon-owned on purpose: the live step counts belong to
 * background conversations the client's turn store knows nothing about, and
 * the same checklist has to converge across the desktop, web and mobile
 * clients.
 *
 * The read is gated three ways, so a client that cannot use the feature never
 * asks for it: the flag arm must select a list, the daemon must carry the
 * routes, and the org header must be ready (a platform-mode read without it is
 * rejected, and the rejection would be cached). The first two are
 * `useActivationEnabledListId`, the shared leaf gate; the route half of it is
 * scoped to the active assistant, so a version still held for the assistant
 * the user just left cannot authorize a read against this one.
 *
 * The query key and its invalidation are exported beside the read. Every
 * writer refreshes the same cache entry, and a hand-built key at each of them
 * is a chance for one to name a different one.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import {
  activationProgressGetOptions,
  activationProgressGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ActivationProgressGetResponse } from "@/generated/daemon/types.gen";
import { useActivationEnabledListId } from "@/hooks/use-activation-gate";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export type ActivationProgress = ActivationProgressGetResponse;

export type ActivationTaskProgress = ActivationProgress["tasks"][string];

/** What the row shows, derived from the daemon's record for the task. */
export type ActivationRowStatus = "todo" | "working" | "done";

/**
 * The row treatment one task's record calls for. Lives with the progress types
 * rather than with the row that draws them, so a hook counting finished tasks
 * reads the same rule the row does without importing a component.
 */
export function activationRowStatus(
  progress: ActivationTaskProgress | null | undefined,
): ActivationRowStatus {
  if (progress?.status === "done") {
    return "done";
  }
  if (progress?.status === "started") {
    return "working";
  }
  return "todo";
}

/** The cache entry `useActivationProgress` reads for one assistant. */
export function activationProgressQueryKey(
  assistantId: string,
): ReturnType<typeof activationProgressGetQueryKey> {
  return activationProgressGetQueryKey({
    path: { assistant_id: assistantId },
  });
}

/** Refetch one assistant's progress. Fire and forget, like every caller wants. */
export function invalidateActivationProgress(
  queryClient: QueryClient,
  assistantId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: activationProgressQueryKey(assistantId),
  });
}

export function useActivationProgress(): UseQueryResult<ActivationProgress> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const isOrgReady = useIsOrgReady();
  const listId = useActivationEnabledListId();

  return useQuery({
    ...activationProgressGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: assistantId != null && isOrgReady && listId !== null,
  });
}
