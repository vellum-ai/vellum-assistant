/**
 * Builds the `ToolCallCardData` consumed by `InlineProcessCard` via the
 * background-task descriptor, from a single background task's store entry. Maps
 * the task status to the shared tool-progress card props — the same shape the
 * workflow, subagent, and ACP inline cards feed their shells.
 *
 * Returns `null` when no entry exists for the given id yet — the window where
 * the assistant message containing the inline card mounts a hair before the
 * `background_tool_started` event lands. The card renders `null` in that window
 * so the transcript layout doesn't jiggle, mirroring `useAcpRunCardData`.
 *
 * Visual-state and copy mapping live in `deriveCardState` / `deriveTitle`.
 */

import { useMemo } from "react";

import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import type { ToolProgressCardState } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import {
  backgroundTaskTitle,
  type BackgroundTaskStatus,
} from "@/utils/background-task-status";

export interface BackgroundTaskCardData {
  state: ToolProgressCardState;
  /** Header headline, keyed off the task status. */
  title: string;
  /** Secondary descriptor — the command being run. */
  info: string;
  /** Tool that spawned the task (`bash` / `host_bash`) — drives the glyph. */
  toolName: string;
}

/**
 * Translate the task status to a shell-compatible visual state. A `cancelled`
 * task reads as a `warning` (user-stopped, partial work); a `failed` one as an
 * `error`.
 */
function deriveCardState(status: BackgroundTaskStatus): ToolProgressCardState {
  switch (status) {
    case "running":
      return "loading";
    case "completed":
      return "complete";
    case "cancelled":
      return "warning";
    case "failed":
      return "error";
  }
}

/**
 * React hook: subscribe to the background task store entry for `id` and project
 * it into card props. Returns `null` when no entry exists yet so callers can
 * short-circuit rendering.
 */
export function useBackgroundTaskCardData(
  id: string,
): BackgroundTaskCardData | null {
  const entry = useBackgroundTaskStore((s) => s.byId[id]);

  return useMemo(() => {
    if (!entry) return null;
    return {
      state: deriveCardState(entry.status),
      title: backgroundTaskTitle(entry.status),
      info: entry.command,
      toolName: entry.toolName,
    };
  }, [entry]);
}
