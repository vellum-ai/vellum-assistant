/**
 * Recording that a checklist surface was put away.
 *
 * The daemon owns the fact, not the client, because the same person closing
 * the welcome modal on their phone must not meet it again on the desktop. The
 * write also freezes the list id when nothing has frozen one yet, so a user
 * who dismisses before launching anything still keeps the list they saw.
 *
 * The dismissal is written into the progress cache before it goes on the wire,
 * so every surface reading that cache agrees with the screen at once: the
 * modal closes and the pill takes its place without waiting on a round trip.
 *
 * A failed write is not surfaced. The surface has already closed by the time
 * it lands, the query refetch puts the truth back on the next read, and the
 * worst case is the modal returning once, which is a far smaller cost than a
 * toast about a checklist the user just said they were done with.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  activationProgressGetQueryKey,
  activationProgressGetSetQueryData,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { activationDismissPost } from "@/generated/daemon/sdk.gen";
import { useActivationChecklistArm } from "@/hooks/use-activation-checklist-flag";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { emitActivationEvent } from "@/utils/activation-telemetry";

/** Which surface the user closed. Mirrors the daemon's `kind`. */
export type ActivationDismissKind = "modal" | "all-done";

export interface UseDismissActivation {
  dismiss: (kind: ActivationDismissKind) => void;
}

/**
 * `listId` is nullable because the caller reads it from the same gate stack
 * that decides whether a surface shows at all: before that resolves there is
 * nothing to dismiss, and a write naming no list would freeze an empty one.
 */
export function useDismissActivation(
  listId: string | null,
): UseDismissActivation {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const arm = useActivationChecklistArm();
  const queryClient = useQueryClient();

  const dismiss = useCallback(
    (kind: ActivationDismissKind) => {
      if (!assistantId || listId === null) {
        return;
      }
      emitActivationEvent("activation_modal_dismissed", { arm, listId });
      // The daemon stamps the same two fields, and freezes the list when
      // nothing has frozen one yet. An absent cache is left absent: a progress
      // document the client invented would turn on surfaces the missing read
      // keeps hidden.
      const now = new Date().toISOString();
      activationProgressGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        (cached) =>
          cached
            ? {
                ...cached,
                listId: cached.listId ?? listId,
                ...(kind === "all-done"
                  ? { allDoneShownAt: now }
                  : { modalDismissedAt: now }),
              }
            : cached,
      );
      void activationDismissPost({
        path: { assistant_id: assistantId },
        body: { kind, listId },
        throwOnError: false,
      }).then(
        ({ response }) => {
          // Only a write the daemon accepted is worth refetching. A refused
          // one keeps the optimistic dismissal so the pill stays reachable
          // instead of a refetch restoring a modal the user already closed.
          if (!response?.ok) {
            return;
          }
          void queryClient.invalidateQueries({
            queryKey: activationProgressGetQueryKey({
              path: { assistant_id: assistantId },
            }),
          });
        },
        () => {},
      );
    },
    [arm, assistantId, listId, queryClient],
  );

  return { dismiss };
}
