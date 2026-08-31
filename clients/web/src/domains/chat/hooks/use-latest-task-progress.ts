/**
 * The newest task-progress card in the open thread.
 *
 * The progress control resolves its own target rather than being pointed at
 * one: the last `task_progress` card surface in the thread, live while the
 * assistant works through its steps and settled on the finished plan after.
 *
 * Scans the rendered transcript (server history and the in-flight turn)
 * backwards, newest message first, and within a message takes its LAST
 * qualifying surface. A single reply can show more than one plan; the later one
 * supersedes it, the same way it would have read in the transcript.
 */

import { useMemo } from "react";

import { isTaskProgressSurface } from "@/domains/chat/transcript/message-content";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { Surface } from "@/domains/chat/types/types";

/**
 * How far back from the tail the scan looks before giving up.
 *
 * The scan normally exits within a message or two, since a thread running a
 * plan has that plan at the end. The bound is for the other case: a long thread
 * with no plan anywhere would otherwise re-walk every message on each
 * transcript change, which during a stream means once per token.
 *
 * It also happens to be the behaviour we want. This surface reports what the
 * assistant is doing NOW; a plan buried fifty replies back is history, not
 * progress, and the rail is honest to go quiet rather than resurface it.
 */
const MAX_MESSAGES_SCANNED = 40;

export function useLatestTaskProgress(): Surface | null {
  const messages = useTranscriptMessages();

  return useMemo(() => {
    const floor = Math.max(0, messages.length - MAX_MESSAGES_SCANNED);
    for (let m = messages.length - 1; m >= floor; m -= 1) {
      const surfaces = messages[m]!.surfaces;
      if (!surfaces) {
        continue;
      }
      for (let s = surfaces.length - 1; s >= 0; s -= 1) {
        const surface = surfaces[s]!;
        if (isTaskProgressSurface(surface)) {
          return surface;
        }
      }
    }
    return null;
  }, [messages]);
}
