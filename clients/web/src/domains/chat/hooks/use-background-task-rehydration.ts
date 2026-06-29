/**
 * Rehydrate in-flight background tasks from the daemon on conversation load.
 *
 * On conversation change, fetch the daemon's active `background-tools` list for
 * the conversation and `seedFromHistory` the background-task store so tasks
 * still running on the daemon reappear as active entries after a refresh.
 *
 * The list route carries no exit/output, so seeded entries are always
 * "running" until a `background_tool_completed` event settles them.
 *
 * An authoritative snapshot also retires tasks the daemon no longer reports —
 * the daemon restarted and lost the subprocess, so no completion event will
 * ever land. `knownIds` is captured BEFORE the fetch (scoped to this
 * conversation) so a task spawned mid-flight — present in the store but absent
 * from the pre-fetch snapshot — is left running rather than wrongly retired.
 */

import { useEffect } from "react";

import { backgroundtoolsGet } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import {
  useBackgroundTaskStore,
  type BackgroundTaskEntry,
} from "@/domains/chat/background-task-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** A single active-tool row from the daemon list route. */
type BackgroundToolListItem =
  NonNullable<
    Awaited<ReturnType<typeof backgroundtoolsGet>>["data"]
  >["tools"][number];

function toTaskEntry(tool: BackgroundToolListItem): BackgroundTaskEntry {
  return {
    id: tool.id,
    toolName: tool.toolName,
    conversationId: tool.conversationId,
    command: tool.command,
    startedAt: tool.startedAt,
    status: "running",
  };
}

/**
 * Fetch the authoritative active-task snapshot for a conversation. Returns
 * `null` on a failed/non-ok fetch so callers distinguish "couldn't load" from
 * an authoritative empty snapshot (which must retire stale tasks).
 */
export async function fetchBackgroundTasks(
  assistantId: string,
  conversationId: string,
): Promise<BackgroundTaskEntry[] | null> {
  try {
    const { data, response } = await backgroundtoolsGet({
      path: { assistant_id: assistantId },
      query: { conversationId },
      throwOnError: false,
    });
    if (!response?.ok || !data?.tools) return null;
    return data.tools.map(toTaskEntry);
  } catch (err) {
    captureError(err, { context: "fetchBackgroundTasks" });
    return null;
  }
}

/** Ids of tasks in the store that belong to `conversationId`. */
function knownTaskIdsFor(conversationId: string): string[] {
  const { byId } = useBackgroundTaskStore.getState();
  return Object.keys(byId).filter(
    (id) => byId[id]?.conversationId === conversationId,
  );
}

/**
 * Apply an authoritative snapshot: seed the reported running tasks and retire
 * any task known before the fetch that the daemon no longer reports. A `null`
 * snapshot means the fetch failed, so nothing is reconciled.
 */
export function applyBackgroundTaskSnapshot(
  entries: BackgroundTaskEntry[] | null,
  knownIds: string[],
): void {
  if (entries === null) return;
  const store = useBackgroundTaskStore.getState();
  if (entries.length > 0) store.seedFromHistory(entries);
  store.retireMissing(
    entries.map((e) => e.id),
    knownIds,
  );
}

export function useBackgroundTaskRehydration(
  conversationId: string | null,
): void {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  useEffect(() => {
    if (!assistantId || !conversationId) return;
    let cancelled = false;
    const knownIds = knownTaskIdsFor(conversationId);
    void fetchBackgroundTasks(assistantId, conversationId).then((entries) => {
      if (cancelled) return;
      applyBackgroundTaskSnapshot(entries, knownIds);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId, conversationId]);

  // Reconcile on SSE reopen: a connection that dropped past the daemon's replay
  // ring can miss a `background_tool_completed`, leaving the entry stuck
  // `running` (stale overlay + Stop control). Re-fetching the authoritative
  // active snapshot retires those tasks. `fresh`/`anchor` opens are skipped —
  // the conversation effect above already owns the initial load.
  useBusSubscription(
    "sse.opened",
    ({ assistantId: openedAssistantId, cause }) => {
      if (cause === "fresh" || cause === "anchor") return;
      if (!assistantId || !conversationId || openedAssistantId !== assistantId) {
        return;
      }
      const knownIds = knownTaskIdsFor(conversationId);
      void fetchBackgroundTasks(assistantId, conversationId).then((entries) => {
        applyBackgroundTaskSnapshot(entries, knownIds);
      });
    },
  );
}
