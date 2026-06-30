/**
 * Imperative actions for background bash/host_bash tasks: stop (cancel).
 *
 * Unlike the ACP routes, the daemon's `background-tools/cancel` endpoint IS in
 * the generated web SDK, so this calls the generated `backgroundtoolsCancelPost`
 * directly. The gateway proxies it via `/v1/assistants/{id}/background-tools/...`.
 */

import { backgroundtoolsCancelPost } from "@/generated/daemon/sdk.gen";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

function activeAssistantId(): string {
  const id = useResolvedAssistantsStore.getState().activeAssistantId;
  if (!id) throw new Error("No active assistant");
  return id;
}

/**
 * Cancel a running background task. Optimistically marks the task cancelled so
 * the live card reflects the user's intent immediately; rolls the status back
 * if the cancel request fails so the Stop control reappears.
 */
export async function stopBackgroundTask(id: string): Promise<void> {
  // Resolve preconditions BEFORE the optimistic write so a missing active
  // assistant can't leave the task stuck `cancelled` with no way back.
  const assistantId = activeAssistantId();
  const store = useBackgroundTaskStore.getState();
  const prevStatus = store.byId[id]?.status;
  store.cancelTask(id);
  try {
    const { data, response } = await backgroundtoolsCancelPost({
      path: { assistant_id: assistantId },
      body: { id },
      throwOnError: false,
    });
    // The route answers 200 with `{ cancelled: false }` when the task was
    // already gone — nothing was stopped, so treat it like a failed request and
    // roll back the optimistic cancel below.
    if (!response?.ok || data?.cancelled === false) {
      throw new Error(
        `Failed to stop background task: ${response?.status} (cancelled=${data?.cancelled})`,
      );
    }
  } catch (err) {
    // The cancel didn't land — roll back the optimistic `cancelled` so the task
    // and its Stop control reappear.
    if (prevStatus !== undefined) {
      useBackgroundTaskStore.getState().restoreTaskStatus(id, prevStatus);
    }
    throw err;
  }
}
