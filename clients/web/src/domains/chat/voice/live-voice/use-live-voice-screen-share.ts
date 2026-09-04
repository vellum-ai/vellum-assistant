/**
 * The session's view of the user's screen: frames of the display or window
 * they are sharing with the call, taken by the host's helper and handed to the
 * session as `sight_frame`, for as long as the share is on and the session can
 * be shown anything.
 *
 * What the companion's share control on macOS drives. That surface is a
 * separate window that draws the call and holds none of it, and the voice room
 * is not open during a companion call, so there is no viewfinder and nothing
 * on screen to sample. There is also no stream: the helper takes one JPEG of
 * the target when asked (`captureCompanionScreen`), and every frame goes
 * through `sight-capture.ts`, which the room's Live shares, to be uploaded and
 * sent. The daemon persists each as its own user message, so the transcript is
 * the record of what the call was shown.
 *
 * ## Cadence
 *
 * A frame when the share starts, and one at each edge of the user's turn: as
 * they start talking and as they stop. The start is the one the turn will
 * read, since the daemon snapshots the conversation the instant the utterance
 * closes (see `use-voice-room-sight.ts`); the end lands on the turn after, as
 * the view the user left behind. Nothing in between and nothing while nobody
 * is talking. A screen changes by whole views rather than by motion, so the
 * gate the camera runs is not consulted; this is the plain cadence, and the
 * floor below is only there so a cough is not two frames.
 *
 * ## What the control reads
 *
 * `screenShareTarget` is the ask, and it is also what the companion mirror
 * publishes as the share being on, so it stays set only while frames can
 * flow. A target the helper cannot take a frame of (the window closed, the
 * display unplugged, Screen Recording not granted) lowers the ask, so the
 * control reads as off rather than as a share nothing is showing, and a later
 * press asks afresh.
 *
 * ## Consent
 *
 * Only a press on the control starts a share, and main frames what is shared
 * for as long as it is. The share stops on a second press, when the session
 * ends (the target is session state), when the assistant refuses the frame,
 * when a frame cannot be taken, and when this hook unmounts, which is the chat
 * layout going away. Each frame lands in the transcript, where the user can
 * see it and delete it.
 *
 * The stop is taken synchronously, inside the store write that ends the share,
 * rather than in this hook's cleanup a render later: a frame uploading in that
 * gap would otherwise be sent after the user pressed stop. A transport
 * reconnect keeps the share and voids what was in flight across it, so a view
 * from before the drop cannot land in the resumed transcript as the current
 * one.
 */

import { useEffect, useState } from "react";

import {
  isLiveVoiceSessionActive,
  isLiveVoiceUserSpeaking,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { createSightCapture } from "@/domains/chat/voice/live-voice/sight-capture";
import { useSupportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
import { captureCompanionScreen } from "@/runtime/companion-surface";
import type { WatchCaptureTarget } from "@vellumai/ipc-contract";

/** Where a failure is filed, so the tag says which source it came from. */
const ERROR_CONTEXT = "live-voice screen share: capture/upload frame";

/**
 * The least time between two frames. The two edges of a very short utterance
 * (a "yes", a cough the VAD opened on) would otherwise be two frames of the
 * same view a beat apart.
 */
export const SCREEN_SHARE_MIN_FRAME_GAP_MS = 1500;

/** The helper's JPEG as the file the upload path takes, or null for no frame. */
async function produceSharedFrame(
  target: WatchCaptureTarget,
  filename: string,
): Promise<File | null> {
  const frame = await captureCompanionScreen(target);
  if (frame === null) {
    return null;
  }
  const bytes = Uint8Array.from(atob(frame.jpegBase64), (char) =>
    char.charCodeAt(0),
  );
  return new File([bytes], filename, { type: "image/jpeg" });
}

export function useLiveVoiceScreenShare(): void {
  const target = useLiveVoiceStore.use.screenShareTarget();
  const state = useLiveVoiceStore.use.state();
  const assistantId = useLiveVoiceStore.use.assistantId();
  const sightFramesUnsupported = useLiveVoiceStore.use.sightFramesUnsupported();
  const supportsFrames = useSupportsSightStream(assistantId);
  // Every term, so the share is absent rather than half-present: the ask, a
  // session for the frames to land in, an assistant that understands the
  // frame, and a session that has not latched the frame as unsupported.
  const active =
    target !== null &&
    isLiveVoiceSessionActive(state) &&
    supportsFrames &&
    assistantId !== null &&
    !sightFramesUnsupported;

  // One for the mount: the assistant is handed to each capture by the run
  // that took the frame, and each run re-bases the order on its way out.
  const [sight] = useState(() => createSightCapture(ERROR_CONTEXT));

  useEffect(() => {
    // `active` already has both in it; the second and third tests are for the
    // narrowing.
    if (!active || target === null || assistantId === null) {
      return;
    }
    let cancelled = false;
    let lastFrameAt = Number.NEGATIVE_INFINITY;
    sight.grantConsent();

    const share = (): void => {
      const now = performance.now();
      if (now - lastFrameAt < SCREEN_SHARE_MIN_FRAME_GAP_MS) {
        return;
      }
      lastFrameAt = now;
      let missed = false;
      void sight
        .capture({
          assistantId,
          produceFrame: async (filename) => {
            const frame = await produceSharedFrame(target, filename);
            missed = frame === null;
            return frame;
          },
          // Nothing to show: there is no viewfinder to put a pulse on. The
          // transcript is where a frame is seen.
          onShared: () => undefined,
        })
        .then(() => {
          if (cancelled || !missed) {
            return;
          }
          // Not filed: a window that closed or a permission not granted is
          // the desktop's answer, not a fault. Lowering the ask is what tells
          // the control, and this effect's own cleanup ends the run.
          console.warn(
            "[live-voice screen share] no frame of the shared target; stopping the share",
          );
          useLiveVoiceStore.getState().setScreenShareTarget(null);
        });
    };

    share();
    let speaking = isLiveVoiceUserSpeaking(useLiveVoiceStore.getState());
    let reconnecting = useLiveVoiceStore.getState().reconnecting;
    const unsubscribe = useLiveVoiceStore.subscribe((session) => {
      // **The stop is honoured here, not in the cleanup below.** A store
      // subscriber runs inside the `set` that ends the share; the cleanup is
      // a passive effect and runs a render later. An upload resolving in
      // that gap would still read the epoch it was captured under and send a
      // frame of what the user has just stopped showing.
      if (session.screenShareTarget !== target) {
        sight.revokeConsent();
        sight.rebaseSendOrder();
        return;
      }
      // A transport that dropped and came back deliberately keeps the share
      // and the session generation, and `connecting` still reads as a live
      // session, so nothing above tears this run down. A frame captured
      // before the drop would pass both guards and land in the resumed
      // transcript as the current view. The room's sight path draws the same
      // boundary for the same reason.
      if (session.reconnecting !== reconnecting) {
        reconnecting = session.reconnecting;
        if (reconnecting) {
          sight.invalidate();
        }
        return;
      }
      const next = isLiveVoiceUserSpeaking(session);
      if (next === speaking) {
        return;
      }
      speaking = next;
      // A muted mic is a session hearing silence, so nothing is being asked
      // and a frame taken for it would answer nobody.
      if (session.muted) {
        return;
      }
      share();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      // The revocation is the bump that voids every capture in flight; the
      // re-base gives back what was parked behind them.
      sight.revokeConsent();
      sight.rebaseSendOrder();
    };
  }, [active, assistantId, sight, target]);
}
