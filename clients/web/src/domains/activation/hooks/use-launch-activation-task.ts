/**
 * Launching a checklist task: one fresh conversation, started in the
 * background, while the modal stays open.
 *
 * Three writes, in this order: create the conversation, record the link, send
 * the prompt.
 *
 * The conversation is created first because the link and the send both have to
 * name a row the daemon can resolve. A client-minted draft id resolves for
 * neither: `POST /v1/messages` looks the strict `conversationId` field up and
 * 404s on a miss, so a prompt sent against an unmaterialized id never runs.
 *
 * The link is recorded before the prompt is sent. The daemon marks a task done
 * when the linked conversation's first turn completes, so a send that lands
 * before the link exists can finish against a conversation the daemon has no
 * task for, and the row would sit on Working forever. Recording the link first
 * costs one round trip and closes that window.
 *
 * A failed link therefore never sends: an unlinked prompt would run a task the
 * checklist cannot observe. The conversation created for it is given back
 * rather than left in the sidebar as a thread the user never started. The
 * error is returned for the row to show.
 *
 * `launch` never rejects. Every failure, transport included, comes back as a
 * result: the row has to be able to leave its pending state and say what
 * happened, and a launch that has already linked has to hand back the
 * conversation id so the user can open it.
 *
 * Every launch gets its own conversation. Reusing one across tasks would put
 * two prompts in one thread and give the daemon two tasks pointing at the same
 * turn.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
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
  createBackgroundConversation,
  discardBackgroundConversation,
  sendBackgroundPrompt,
} from "@/utils/background-conversation";

import { readRawActivationTask } from "../catalog";

export interface LaunchActivationTaskResult {
  ok: boolean;
  /** The conversation the task was launched into, once one is linked to it. */
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
  const { t } = useTranslation("activation");
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
        return { ok: false, error: t("launch.noAssistant") };
      }
      const override = promptOverride?.trim();
      // Read at click time rather than from a resolved list: the catalog is
      // data and this is an event handler, so the non-reactive binding is the
      // right one (see `@/i18n`).
      const prompt = override || readRawActivationTask(taskId)?.prompt;
      if (!prompt) {
        return { ok: false, error: t("launch.unknownTask") };
      }

      setPendingTaskId(taskId);
      try {
        const created = await createBackgroundConversation(assistantId);
        if (!created.ok) {
          return { ok: false, error: created.error };
        }
        const { conversationId } = created;

        try {
          await startTask({
            path: { assistant_id: assistantId, taskId },
            body: { conversationId, listId },
          });
        } catch (error) {
          void discardBackgroundConversation(assistantId, conversationId);
          return { ok: false, error: extractErrorMessage(error) };
        }

        let sent;
        try {
          sent = await sendBackgroundPrompt({
            assistantId,
            conversationId,
            prompt,
          });
        } catch (error) {
          // The link already stands, so the conversation is the task's; the
          // user can open and drive it whatever the transport did.
          return {
            ok: false,
            conversationId,
            error: extractErrorMessage(error, undefined, t("launch.failed")),
          };
        }
        if (!sent.ok) {
          return {
            ok: false,
            conversationId,
            error: extractErrorMessage(
              sent.error,
              undefined,
              t("launch.failed"),
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
    [arm, assistantId, listId, queryClient, startTask, t],
  );

  return { launch, pendingTaskId };
}
