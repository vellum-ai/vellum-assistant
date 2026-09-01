/**
 * The subagents a message spawned, shown where it spawned them.
 *
 * Renders the SAME control as the floating status cluster ({@link AgentsControl}):
 * the stacked agent marks, opening the same list of sessions, so one set of
 * agents has one appearance wherever it is met.
 *
 * The two mounts do not compete. While this control is on screen the floating
 * copy stands down (see {@link useInlineAgentsVisibilityStore}), because two
 * copies of one control on one screen is noise and this one is anchored to the
 * work. Scroll it away and the floating copy returns.
 *
 * Visibility is reported through an `IntersectionObserver` rather than a scroll
 * calculation: the transcript's scrollport, the message's position in it, and
 * the drawer that may be covering it are all things the observer already knows
 * and a computation here would have to re-derive.
 */

import { useEffect, useMemo, useRef } from "react";

import { AgentsControl } from "@/domains/chat/components/agents-control";
import { useInlineAgentsVisibilityStore } from "@/domains/chat/inline-agents-visibility-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useInView } from "@/hooks/use-in-view";
import { isActiveStatus } from "@/utils/subagent-status";

import type { ConversationActivity } from "@/domains/chat/hooks/use-conversation-activity";

export interface SubagentSpawnGroupProps {
  subagentIds: string[];
  onSubagentClick?: (subagentId: string) => void;
  onStopSubagent?: (subagentId: string) => void;
}

export function SubagentSpawnGroup({
  subagentIds,
  onSubagentClick,
  onStopSubagent,
}: SubagentSpawnGroupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const acquire = useInlineAgentsVisibilityStore.use.acquire();
  const release = useInlineAgentsVisibilityStore.use.release();

  // Held for exactly as long as this control is on screen. The cleanup runs on
  // unmount too, so a group scrolled out of a virtualised transcript releases
  // its claim rather than suppressing the floating copy forever.
  useEffect(() => {
    if (!inView) {
      return;
    }
    acquire();
    return release;
  }, [inView, acquire, release]);

  // Subscribe to just these ids' statuses, so another subagent's token stream
  // doesn't re-render this row.
  const statuses = useSubagentStore((s) =>
    subagentIds.map((id) => s.byId[id]?.status).join("|"),
  );

  const activity = useMemo<ConversationActivity>(() => {
    const byId = useSubagentStore.getState().byId;
    const running: ConversationActivity["running"] = [];
    const completed: ConversationActivity["completed"] = [];
    for (const id of subagentIds) {
      const status = byId[id]?.status;
      // An unknown status is treated as still working: a spawn whose entry has
      // not landed yet is in flight, not finished.
      const row = { kind: "subagent" as const, id };
      if (status === undefined || isActiveStatus(status)) {
        running.push(row);
      } else {
        completed.push(row);
      }
    }
    return { running, completed, total: running.length + completed.length };
    // `statuses` is the subscription; `byId` is read fresh so the memo doesn't
    // hold a stale map.
  }, [subagentIds, statuses]);

  if (subagentIds.length === 0) {
    return null;
  }

  return (
    <div ref={ref} className="flex w-full">
      <AgentsControl
        activity={activity}
        data-testid="subagent-spawn-group-trigger"
        onOpenRow={(_kind, id) => onSubagentClick?.(id)}
        onStopRow={onStopSubagent ? (_kind, id) => onStopSubagent(id) : undefined}
      />
    </div>
  );
}
