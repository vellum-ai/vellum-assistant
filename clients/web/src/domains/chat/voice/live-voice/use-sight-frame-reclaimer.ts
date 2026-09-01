/**
 * Gives back the camera-frame uploads no message will ever carry.
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
 * Some entries carry a `notBefore` and are not the drain's to touch until then
 * (see `PER_JOB_CEILING_MS`, and `queueUnacknowledgedSightFrames` for how the
 * deadline is derived from what can still be queued on the daemon), so this
 * runs on a timer as well as on new work. The timer is armed for the earliest
 * waiting entry, re-arms itself for whatever is left, and is left unarmed once
 * nothing is queued.
 *
 * Deletion failures are logged and dropped. Nobody asked for these uploads and
 * nothing downstream depends on the row being gone, so a failed cleanup is
 * worth a line in the console and nothing more. A refused delete is in fact
 * the expected answer for most of what this queue carries, since a session
 * boundary queues every unacknowledged send and the daemon protects the rows
 * that a message links.
 */

import { useCallback, useEffect } from "react";

import { deleteChatAttachment } from "@/domains/chat/api/messages";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";

export function useSightFrameReclaimer(): void {
  const queued = useLiveVoiceStore.use.sightFramesToReclaim();

  const drainDue = useCallback(() => {
    // Taken rather than read-then-cleared, and the taken set is what gets
    // deleted rather than the one a render captured. An entry queued between
    // that render and this call is inside the take, so it is deleted here
    // instead of being cleared undeleted, and an entry queued after the take
    // stays for the run the new queue triggers.
    const taken = useLiveVoiceStore
      .getState()
      .takeDueSightFrameReclaims(Date.now());
    for (const { assistantId, attachmentId } of taken) {
      void deleteChatAttachment(assistantId, attachmentId).then((ok) => {
        if (!ok) {
          // Logged, not filed. A refusal is the ORDINARY answer here: a
          // session boundary queues every send the assistant never
          // acknowledged, most of those did persist, and the daemon refuses to
          // delete a row a message links. Filing each one would open a Sentry
          // issue on every call that had the camera open, which buries the
          // failures worth reading.
          console.warn(
            `live-voice sight: kept frame ${attachmentId} not reclaimed`,
          );
        }
      });
    }
  }, []);

  useEffect(() => {
    if (queued.length === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Whatever is left is waiting on its own clock, and no store change is
    // coming to wake this, so the wait re-arms itself rather than relying on a
    // render. A timer that wakes a hair short of its entry's deadline takes
    // nothing, and a take that took nothing leaves the queue untouched, so an
    // arm made only where the queue changes would strand that entry for good.
    // Each arm is for the earliest waiting entry, and the queue emptying ends
    // the chain.
    const drainAndArm = (): void => {
      drainDue();
      const pending = useLiveVoiceStore.getState().sightFramesToReclaim;
      if (pending.length === 0) {
        return;
      }
      const now = Date.now();
      const earliest = Math.min(
        ...pending.map((entry) => entry.notBefore ?? now),
      );
      timer = setTimeout(drainAndArm, Math.max(0, earliest - now));
    };
    drainAndArm();
    return () => clearTimeout(timer);
  }, [drainDue, queued]);
}
