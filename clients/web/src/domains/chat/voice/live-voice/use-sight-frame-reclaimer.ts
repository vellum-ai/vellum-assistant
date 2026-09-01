/**
 * Gives back the camera-frame uploads an assistant refused but never stored.
 *
 * Mounted by {@link useLiveVoiceSessionController}, which `ChatLayout` keeps
 * for as long as a session can exist, and that scope is the whole point. The
 * room's own sight hook cannot own this duty: a minimized room is not mounted,
 * so a refusal that lands while the call is running in the background would
 * find nobody to act on it, and ending the call would then take the queue with
 * it. The uploads would be left behind for good, because an assistant that
 * never understood the frame never reclaims them either and nothing else
 * collects an attachment no message links.
 *
 * The queue carries the assistant each id belongs to and is not session state,
 * so a drain that happens after the call ended still deletes against the right
 * assistant.
 *
 * Deletion failures are logged and dropped. Nobody asked for these uploads and
 * nothing downstream depends on the row being gone, so a failed cleanup is
 * worth telemetry and nothing more.
 */

import { useEffect } from "react";

import { deleteChatAttachment } from "@/domains/chat/api/messages";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { captureError } from "@/lib/sentry/capture-error";

export function useSightFrameReclaimer(): void {
  const queued = useLiveVoiceStore.use.sightFramesToReclaim();

  useEffect(() => {
    if (queued.length === 0) {
      return;
    }
    // Taken rather than read-then-cleared, and the taken set is what gets
    // deleted rather than the one this render captured. An entry queued
    // between that render and this effect is inside the take, so it is
    // deleted here instead of being cleared undeleted, and an entry queued
    // after the take stays for the run the new queue triggers.
    const taken = useLiveVoiceStore.getState().takeSightFramesToReclaim();
    for (const { assistantId, attachmentId } of taken) {
      void deleteChatAttachment(assistantId, attachmentId).then((ok) => {
        if (!ok) {
          captureError(new Error("sight frame delete refused"), {
            context: "live-voice sight: reclaim refused frame",
            bestEffort: true,
          });
        }
      });
    }
  }, [queued]);
}
