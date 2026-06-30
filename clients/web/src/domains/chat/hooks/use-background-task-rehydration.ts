/**
 * Rehydrate in-flight background tasks from the daemon on conversation load.
 *
 * On conversation change, fetch the daemon's `background-tools` snapshot for the
 * conversation — both still-active tools and the recently-completed ring — and
 * `seedFromHistory` the background-task store so tasks still running reappear as
 * active entries, and tasks that finished while the chat was unmounted (or with
 * another conversation active) settle to their real terminal status instead of
 * being wrongly retired as cancelled.
 *
 * Active entries carry no exit/output, so they stay "running" until a
 * `background_tool_completed` event settles them; completed-ring entries carry
 * the terminal status/exitCode/output directly.
 *
 * The snapshot also retires tasks the daemon reports in NEITHER list — the
 * daemon restarted and lost the subprocess, so no completion event will ever
 * land. `knownIds` is captured BEFORE the fetch (scoped to this conversation) so
 * a task spawned mid-flight — present in the store but absent from the pre-fetch
 * snapshot — is left running rather than wrongly retired.
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

type BackgroundToolsData = NonNullable<
  Awaited<ReturnType<typeof backgroundtoolsGet>>["data"]
>;
/** A single active-tool row from the daemon list route. */
type BackgroundToolListItem = BackgroundToolsData["tools"][number];
/** A single recently-completed row from the daemon list route. */
type CompletedBackgroundToolListItem = NonNullable<
  BackgroundToolsData["completed"]
>[number];

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

function toCompletedTaskEntry(
  tool: CompletedBackgroundToolListItem,
): BackgroundTaskEntry {
  return {
    id: tool.id,
    toolName: tool.toolName,
    conversationId: tool.conversationId,
    command: tool.command,
    startedAt: tool.startedAt,
    status: tool.status,
    exitCode: tool.exitCode,
    output: tool.output,
    completedAt: tool.completedAt,
  };
}

/** Active (still-running) tasks and recently-completed terminal tasks. */
export interface BackgroundTaskSnapshot {
  active: BackgroundTaskEntry[];
  completed: BackgroundTaskEntry[];
}

/**
 * Fetch the authoritative task snapshot for a conversation: the daemon's active
 * tools plus its recently-completed ring. Returns `null` on a failed/non-ok
 * fetch so callers distinguish "couldn't load" from an authoritative empty
 * snapshot (which must retire stale tasks).
 */
export async function fetchBackgroundTasks(
  assistantId: string,
  conversationId: string,
): Promise<BackgroundTaskSnapshot | null> {
  try {
    const { data, response } = await backgroundtoolsGet({
      path: { assistant_id: assistantId },
      query: { conversationId },
      throwOnError: false,
    });
    if (!response?.ok || !data?.tools) return null;
    return {
      active: data.tools.map(toTaskEntry),
      completed: (data.completed ?? []).map(toCompletedTaskEntry),
    };
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
 * Apply an authoritative snapshot: seed the reported running tasks and the
 * recently-completed ones (so a task that finished while the chat was unmounted
 * settles to its real terminal status instead of being retired as cancelled),
 * then retire any task known before the fetch that the daemon reports in
 * neither list — it was genuinely lost (e.g. daemon restart). A `null` snapshot
 * means the fetch failed, so nothing is reconciled.
 */
export function applyBackgroundTaskSnapshot(
  snapshot: BackgroundTaskSnapshot | null,
  knownIds: string[],
): void {
  if (snapshot === null) return;
  const store = useBackgroundTaskStore.getState();
  const seedable = [...snapshot.active, ...snapshot.completed];
  if (seedable.length > 0) store.seedFromHistory(seedable);
  // Only the still-active ids count as "present"; a completed entry was seeded
  // terminal above, so retireMissing skips it (not an active status) regardless.
  store.retireMissing(
    snapshot.active.map((e) => e.id),
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
    void fetchBackgroundTasks(assistantId, conversationId).then((snapshot) => {
      if (cancelled) return;
      applyBackgroundTaskSnapshot(snapshot, knownIds);
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
      void fetchBackgroundTasks(assistantId, conversationId).then((snapshot) => {
        applyBackgroundTaskSnapshot(snapshot, knownIds);
      });
    },
  );
}
