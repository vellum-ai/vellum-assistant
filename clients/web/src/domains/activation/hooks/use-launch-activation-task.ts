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
 * checklist cannot observe. What becomes of the conversation depends on how
 * the link failed. A 4xx is the daemon answering and refusing, so nothing
 * points at the conversation and it is given back rather than left in the
 * sidebar as a thread the user never started. Every other failure leaves the
 * link's fate unknown: the daemon may already hold it, so the conversation is
 * kept and its id handed back alongside the error for the row to recover from.
 *
 * `launch` never rejects. Every failure, transport included, comes back as a
 * result: the row has to be able to leave its pending state and say what
 * happened, and a launch that has already linked has to hand back the
 * conversation id so the user can open it.
 *
 * Every launch gets its own conversation. Reusing one across tasks would put
 * two prompts in one thread and give the daemon two tasks pointing at the same
 * turn.
 *
 * Launches run concurrently and are tracked as a set, because the list lets the
 * user start a second task while the first is still in flight. A single pending
 * id would clear on whichever launch settled first and hand every other row
 * back to the user mid-launch. The set is mirrored in a ref so the duplicate
 * guard answers within the click that fires it, before React has re-rendered
 * the row into its pending state.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

import { activationProgressGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { activationTasksByTaskIdStartPost } from "@/generated/daemon/sdk.gen";
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

/**
 * A link the client never saw succeed. `rejected` is true only when the daemon
 * answered with a 4xx, which is the one case where the link certainly does not
 * exist.
 */
interface LinkFailure {
  rejected: boolean;
  error: string;
}

interface LinkActivationTaskArgs {
  assistantId: string;
  taskId: string;
  listId: string;
  conversationId: string;
  /** Copy to show when the failure carried no message of its own. */
  fallback: string;
}

/**
 * Record the task's link to `conversationId`, and say what a failure was.
 *
 * Called through the SDK rather than the generated react-query mutation
 * because that mutation throws the parsed body and drops the response: only an
 * answered 4xx proves the link does not exist, and telling that apart from a
 * transport failure or a 5xx needs the status in hand. A 5xx counts as unknown
 * on purpose, since the daemon can persist the link and then fail to answer.
 */
async function linkActivationTask({
  assistantId,
  taskId,
  listId,
  conversationId,
  fallback,
}: LinkActivationTaskArgs): Promise<LinkFailure | null> {
  try {
    const { error, response } = await activationTasksByTaskIdStartPost({
      path: { assistant_id: assistantId, taskId },
      body: { conversationId, listId },
      throwOnError: false,
    });
    if (response?.ok) {
      return null;
    }
    const status = response?.status;
    return {
      rejected: status !== undefined && status >= 400 && status < 500,
      error: extractErrorMessage(error, response, fallback),
    };
  } catch (error) {
    return {
      rejected: false,
      error: extractErrorMessage(error, undefined, fallback),
    };
  }
}

export interface LaunchActivationTaskResult {
  ok: boolean;
  /** The conversation the task was launched into, once one is linked to it. */
  conversationId?: string;
  /**
   * What to tell the user. Absent when there is nothing to say: a launch
   * refused because the same task is already running is not a failure the user
   * caused or needs to see.
   */
  error?: string;
}

export interface UseLaunchActivationTask {
  /**
   * Launch `taskId` into a fresh background conversation, sending its catalog
   * prompt. `promptOverride` carries whatever the user typed into the row's
   * "Custom:" field and replaces it; a nonblank one is sent as a typed turn
   * rather than a scripted one.
   */
  launch: (
    taskId: string,
    promptOverride?: string,
  ) => Promise<LaunchActivationTaskResult>;
  /** Every task whose launch is in flight, for the rows' pending states. */
  pendingTaskIds: ReadonlySet<string>;
  /** Whether `taskId`'s own launch is still in flight. */
  isPending: (taskId: string) => boolean;
}

const NONE_PENDING: ReadonlySet<string> = new Set();

export function useLaunchActivationTask(
  listId: string,
): UseLaunchActivationTask {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const arm = useActivationChecklistArm();
  const queryClient = useQueryClient();
  const { t } = useTranslation("activation");
  const [pendingTaskIds, setPendingTaskIds] =
    useState<ReadonlySet<string>>(NONE_PENDING);
  // The ref is the authority the guard reads; the state is the copy React
  // renders. Two clicks in one tick both see the ref, and only one gets past.
  const inFlight = useRef<Set<string>>(new Set());

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
      // A nonblank override is what the user typed into the row's Custom
      // field, so the turn is typed engagement and activation analytics has to
      // count it. Only the catalog prompt is scripted.
      const scripted = !override;

      // The row is already working. Launching again would open a second
      // conversation for one task and leave the daemon two rows to mark done.
      if (inFlight.current.has(taskId)) {
        return { ok: false };
      }
      inFlight.current.add(taskId);
      setPendingTaskIds(new Set(inFlight.current));
      try {
        const created = await createBackgroundConversation({
          assistantId,
          fallback: t("launch.failed"),
        });
        if (!created.ok) {
          return { ok: false, error: created.error };
        }
        const { conversationId } = created;

        const linkFailure = await linkActivationTask({
          assistantId,
          taskId,
          listId,
          conversationId,
          fallback: t("launch.failed"),
        });
        if (linkFailure) {
          if (linkFailure.rejected) {
            void discardBackgroundConversation(assistantId, conversationId);
            return { ok: false, error: linkFailure.error };
          }
          return { ok: false, conversationId, error: linkFailure.error };
        }

        let sent;
        try {
          sent = await sendBackgroundPrompt({
            assistantId,
            conversationId,
            prompt,
            scripted,
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
        inFlight.current.delete(taskId);
        setPendingTaskIds(new Set(inFlight.current));
      }
    },
    [arm, assistantId, listId, queryClient, t],
  );

  const isPending = useCallback(
    (taskId: string) => pendingTaskIds.has(taskId),
    [pendingTaskIds],
  );

  return { launch, pendingTaskIds, isPending };
}
