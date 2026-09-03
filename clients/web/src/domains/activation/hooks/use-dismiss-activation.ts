/**
 * Recording that a checklist surface was put away.
 *
 * The daemon owns the fact, not the client, because the same person closing
 * the welcome modal on their phone must not meet it again on the desktop. The
 * write also freezes the list id when nothing has frozen one yet, so a user
 * who dismisses before launching anything still keeps the list they saw.
 *
 * A failed write is not surfaced. The surface has already closed by the time
 * it lands, the query refetch puts the truth back on the next read, and the
 * worst case is the modal returning once, which is a far smaller cost than a
 * toast about a checklist the user just said they were done with.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { activationProgressGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
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
      void activationDismissPost({
        path: { assistant_id: assistantId },
        body: { kind, listId },
        throwOnError: false,
      }).finally(() => {
        void queryClient.invalidateQueries({
          queryKey: activationProgressGetQueryKey({
            path: { assistant_id: assistantId },
          }),
        });
      });
    },
    [arm, assistantId, listId, queryClient],
  );

  return { dismiss };
}
