/**
 * The rendered transcript: the materialized snapshot overlaid with the
 * client's optimistic sends.
 *
 * The snapshot (chat-session store) is the conversation's history seeded from
 * the `/messages` snapshot and advanced by the stream reducer; `optimisticSends`
 * holds user sends not yet confirmed by their echo. `selectTranscriptMessages`
 * overlays the optimistic rows onto the snapshot by message identity (so an
 * optimistic send collapses onto its echoed server row), in snapshot order,
 * with no timestamp sort. This is the single read seam every transcript
 * consumer goes through.
 */

import { useMemo } from "react";

import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { filterDismissedSurfaces } from "@/domains/chat/utils/dismissed-surfaces-storage";
import type { DisplayMessage } from "@/domains/chat/types/types";

export function useTranscriptMessages(): DisplayMessage[] {
  const messages = useChatSessionStore.use.snapshot()?.messages;
  const optimisticSends = useChatSessionStore.use.optimisticSends();
  const dismissedSurfaceIds = useChatSessionStore.use.dismissedSurfaceIds();

  return useMemo(() => {
    // Dismissed surfaces are client state that hides server-sent surface rows;
    // apply it at read time (returns the same ref when nothing is dismissed,
    // so the steady-state union stays referentially stable).
    const visibleHistory = filterDismissedSurfaces(
      messages,
      dismissedSurfaceIds,
    );
    return selectTranscriptMessages(visibleHistory, optimisticSends);
    // Key on `snapshot.messages`, not the whole snapshot: the rolling-snapshot
    // reducer mints a new snapshot object on every stream event but reuses the
    // same `messages` array for events that don't change transcript content
    // (turn lifecycle, subagent/workflow progress, sync). Depending on the
    // messages array avoids re-deriving the transcript — and thrashing every
    // downstream memo and the scroll classifier — on that no-op churn, which
    // is heaviest exactly when an app surface arrives mid-stream.
  }, [messages, optimisticSends, dismissedSurfaceIds]);
}
