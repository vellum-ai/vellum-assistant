/**
 * Launching a checklist task: one fresh conversation, started in the
 * background, while the modal stays open.
 *
 * The order of the two writes matters. The link is recorded FIRST, then the
 * prompt is sent. The daemon marks a task done when the linked conversation's
 * first turn completes, so a send that lands before the link exists can finish
 * against a conversation the daemon has no task for, and the row would sit on
 * Working forever. Recording the link first costs one round trip and closes
 * that window.
 *
 * A failed link therefore never sends: an unlinked prompt would run a task the
 * checklist cannot observe. The error is returned for the row to show.
 *
 * Every launch mints its own conversation. Reusing one across tasks would put
 * two prompts in one thread and give the daemon two tasks pointing at the same
 * turn.
 */

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  activationProgressGetQueryKey,
  activationTasksByTaskIdStartPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivationChecklistArm } from "@/hooks/use-activation-checklist-flag";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { emitActivationEvent } from "@/utils/activation-telemetry";
import { extractErrorMessage } from "@/utils/api-errors";
import {
  mintBackgroundConversationId,
  sendBackgroundPrompt,
} from "@/utils/background-conversation";

import { readRawActivationTask } from "../catalog";

export interface LaunchActivationTaskResult {
  ok: boolean;
  /** The conversation the task was launched into, once one has been minted. */
  conversationId?: string;
  error?: string;
}

export interface UseLaunchActivationTask {
  /**
   * Launch `taskId` into a fresh background conversation, sending its catalog
   * prompt. `promptOverride` carries whatever the user typed into the row's
   * "Custom:" field and replaces it.
   */
  launch: (
    taskId: string,
    promptOverride?: string,
  ) => Promise<LaunchActivationTaskResult>;
  /** The task currently mid-launch, for the row's pending state. */
  pendingTaskId: string | null;
}

export function useLaunchActivationTask(
  listId: string,
): UseLaunchActivationTask {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const arm = useActivationChecklistArm();
  const queryClient = useQueryClient();
  const { mutateAsync: startTask } = useMutation(
    activationTasksByTaskIdStartPostMutation(),
  );
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const launch = useCallback(
    async (
      taskId: string,
      promptOverride?: string,
    ): Promise<LaunchActivationTaskResult> => {
      if (!assistantId) {
        return { ok: false, error: "No active assistant" };
      }
      const override = promptOverride?.trim();
      // Read at click time rather than from a resolved list: the catalog is
      // data and this is an event handler, so the non-reactive binding is the
      // right one (see `@/i18n`).
      const prompt = override || readRawActivationTask(taskId)?.prompt;
      if (!prompt) {
        return { ok: false, error: "Unknown task" };
      }

      const conversationId = mintBackgroundConversationId();
      setPendingTaskId(taskId);
      try {
        try {
          await startTask({
            path: { assistant_id: assistantId, taskId },
            body: { conversationId, listId },
          });
        } catch (error) {
          return { ok: false, error: extractErrorMessage(error) };
        }

        const sent = await sendBackgroundPrompt({
          assistantId,
          conversationId,
          prompt,
        });
        if (!sent.ok) {
          // The link already stands, so the conversation is the task's; a
          // failed send leaves it empty and the user can open and drive it.
          return {
            ok: false,
            conversationId,
            error: extractErrorMessage(
              sent.error,
              undefined,
              "Could not start the task. Please try again.",
            ),
          };
        }

        emitActivationEvent("activation_task_started", { arm, listId, taskId });
        void queryClient.invalidateQueries({
          queryKey: activationProgressGetQueryKey({
            path: { assistant_id: assistantId },
          }),
        });
        return { ok: true, conversationId };
      } finally {
        setPendingTaskId(null);
      }
    },
    [arm, assistantId, listId, queryClient, startTask],
  );

  return { launch, pendingTaskId };
}
