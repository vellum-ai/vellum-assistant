/**
 * Sight in the voice room: the open viewfinder feeding the call what it can
 * see, without anyone pressing anything.
 *
 * The shutter next door answers "look at this". This answers "here is what I am
 * holding while I talk about it", which is a different interaction and cannot
 * be built out of shutter presses: the frame has to be in hand before the
 * sentence ends, and a person describing an object is not free to also operate
 * a camera.
 *
 * ## The shape of it
 *
 * The gate (`lib/camera/frame-gate.ts`) watches the room's own `<video>` and
 * says which frames are worth keeping. Every keep is uploaded at once and
 * parked on the session with `attach_frame`, whose slot is latest-wins and
 * reclaims what it displaces. The session's own slot is therefore the one
 * holder of the current view, and whichever turn launches next carries it.
 *
 * ## Why parking continuously, rather than at a boundary
 *
 * Because there is no boundary the client can act on in time. The daemon closes
 * an utterance and starts the turn in the same call chain, so a frame sent when
 * the client hears `utterance_end` cannot arrive before the turn drains the
 * slot, and would ride the turn after the one it belonged to. Worse, the
 * boundary is not even a reliable sign a turn is coming: an empty transcript is
 * announced as `utterance_end` and only discovered to be empty later, so a
 * cough would park a frame that then waits for unrelated speech.
 *
 * Keeping the slot always full removes the question. At every boundary, on
 * every path, it already holds the freshest view, so push-to-talk works for
 * free and a cough costs nothing. It also nearly removes the orphan cost the
 * park-on-boundary shape accepted: a keep that never rides a turn is reclaimed
 * by the keep that displaces it.
 *
 * ## Consent
 *
 * There is no second camera and no hidden one. This samples the viewfinder the
 * room already put on screen, so frames flow exactly while the user can see
 * what is being sampled. Closing it stops them and unparks what was staged, so
 * a viewfinder the user put away leaves nothing behind that a later turn could
 * still carry.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteChatAttachment,
  uploadChatAttachment,
} from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import {
  attachLiveVoiceFrame,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  isVisionModeOn,
  useVisionModeVariant,
} from "@/hooks/use-vision-mode-flag";
import { useSupportsSightFrames } from "@/lib/backwards-compat/use-supports-sight-frames";
import {
  DEFAULT_FRAME_GATE_OPTIONS,
  type FrameGate,
  createFrameGate,
} from "@/lib/camera/frame-gate";
import { createFrameSampler } from "@/lib/camera/frame-sampler";
import { captureError } from "@/lib/sentry/capture-error";

import { captureVideoFrame, type VoiceCameraFacing } from "./voice-camera";

/** Where a failure is filed, so the tag reads the same from every path. */
const ERROR_CONTEXT = "voice-room sight: sample/upload frame";

/** The frame the session is holding for whatever turn comes next. */
export interface VoiceRoomSightFrame {
  /** Id from the upload, which is what `attach_frame` parked. */
  readonly attachmentId: string;
  /** When the frame was taken, which is what orders two uploads in flight. */
  readonly atMs: number;
  /** Object URL of the captured frame. Revoked when the frame is dropped. */
  readonly previewUrl: string;
}

export interface VoiceRoomSight {
  /**
   * The freshest view shared with the call, or null when none is.
   *
   * The feature's only visible sign. Frames leave with turns the user did not
   * ask to send anything on, so what is being shared has to be on screen while
   * it is still true.
   *
   * One honest gap: a turn drains the session's slot, and until the gate keeps
   * again (within its rate floor) this still shows the last view while the
   * daemon holds nothing. It reads as "what the call has seen", which is the
   * true half of it, rather than as a claim about the next turn.
   */
  readonly heldFrame: VoiceRoomSightFrame | null;
}

export interface VoiceRoomSightOptions {
  /** Whether the room's viewfinder is up. Nothing is sampled while it is not. */
  readonly cameraOpen: boolean;
  /** Which way the camera points, so a flip can invalidate the gate. */
  readonly facing: VoiceCameraFacing;
}

/** A parked frame plus the bookkeeping the render surface has no use for. */
interface HeldFrame extends VoiceRoomSightFrame {
  /** Session generation at capture. A frame never crosses sessions. */
  readonly sessionGeneration: number;
}

export function useVoiceRoomSight(
  assistantId: string | null,
  /** The room's own ref for the viewfinder `<video>`. */
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { cameraOpen, facing }: VoiceRoomSightOptions,
): VoiceRoomSight {
  const visionMode = useVisionModeVariant();
  const supportsFrames = useSupportsSightFrames(assistantId);
  const [heldFrame, setHeldFrame] = useState<HeldFrame | null>(null);
  // What the teardown and the capture continuations read. The sampler outlives
  // a render, so neither can close over a render's value.
  const heldRef = useRef<HeldFrame | null>(null);
  const gateRef = useRef<FrameGate | null>(null);
  const frameCountRef = useRef(0);
  /**
   * Which camera and transport this capture chain feeds. Bumped when sampling
   * stops, when the camera flips, and when the transport drops into a
   * reconnect, so a capture that was already encoding can tell that the world
   * it was headed for is gone.
   *
   * The session generation covers none of the three: each leaves the logical
   * call running, a flip deliberately keeps the sampler on the same element,
   * and a reconnect deliberately keeps the generation, so a stalled upload
   * from before any of them could otherwise be parked as the current view.
   */
  const captureEpochRef = useRef(0);

  // All three, so the feature is absent rather than half-present: no camera on
  // screen is no consent, a flag off is not shipped, and an assistant that
  // predates `attach_frame` answers every one with the error code the
  // transport reads as a settings rejection.
  const active =
    cameraOpen && isVisionModeOn(visionMode) && supportsFrames && !!assistantId;

  /**
   * Replace the frame on screen, giving back whatever preview it displaced.
   * Revoking is not bookkeeping: each preview holds a decoded full-resolution
   * frame alive, and a long call keeps a frame every few seconds.
   */
  const hold = useCallback((next: HeldFrame | null) => {
    const previous = heldRef.current;
    heldRef.current = next;
    setHeldFrame(next);
    if (previous && previous.previewUrl !== next?.previewUrl) {
      URL.revokeObjectURL(previous.previewUrl);
    }
  }, []);

  const captureAndHold = useCallback(
    async (video: HTMLVideoElement) => {
      if (!assistantId) {
        return;
      }
      // Read before the encode, not after the upload. Everything below can
      // outlive the session and the camera the frame was taken from, and
      // neither can be re-read afterwards without describing the wrong one.
      const sessionGeneration = useLiveVoiceStore.getState().sessionGeneration;
      const captureEpoch = captureEpochRef.current;
      const atMs = Date.now();
      try {
        frameCountRef.current += 1;
        const frame = await captureVideoFrame(
          video,
          `sight-${frameCountRef.current}.jpg`,
        );
        if (!frame) {
          return;
        }

        // The same preparation a pasted image gets, for the same reason the
        // shutter does it: a high-resolution track behaves like every other
        // attachment rather than like a special case.
        const prepared = await prepareImageAttachmentForUpload(frame);
        const file = prepared.status === "failed" ? frame : prepared.file;

        const uploaded = await uploadChatAttachment(assistantId, file);
        if (!uploaded.ok) {
          return;
        }
        /**
         * Give the row back on every path that abandons this id after the
         * upload persisted it. Nothing else can: an attachment is collected
         * when the message linking it is deleted, or by the daemon reclaiming
         * a frame from its own slot, and an id that reaches neither is a row
         * and its bytes kept for good.
         */
        const abandonUpload = (): void => {
          void deleteChatAttachment(assistantId, uploaded.id).then((ok) => {
            if (!ok) {
              captureError(new Error("sight frame delete refused"), {
                context: ERROR_CONTEXT,
                bestEffort: true,
              });
            }
          });
        };

        if (
          useLiveVoiceStore.getState().sessionGeneration !== sessionGeneration
        ) {
          abandonUpload();
          return;
        }
        // The camera this came from is closed or pointing elsewhere, so this
        // is a view of nothing the user is looking at now.
        if (captureEpoch !== captureEpochRef.current) {
          abandonUpload();
          return;
        }
        // Latest wins by CAPTURE time, not by resolve order: two uploads can be
        // in flight and the slower one is not the newer view. Losing here is
        // the whole cost of a superseded frame, so it is simply dropped.
        const held = heldRef.current;
        if (held && held.atMs >= atMs) {
          abandonUpload();
          return;
        }
        // Parked before it is shown, and shown only if it was parked. The
        // thumbnail claims the call can see this frame, and during a reconnect
        // gap it cannot: what stays on screen is then the older frame the
        // session's slot really does hold. A frame that never reached the slot
        // is this hook's to give back, since the daemon never saw it.
        if (!attachLiveVoiceFrame(uploaded.id, sessionGeneration)) {
          abandonUpload();
          return;
        }
        hold({
          attachmentId: uploaded.id,
          atMs,
          previewUrl: URL.createObjectURL(frame),
          sessionGeneration,
        });
      } catch (cause) {
        // Best effort by design: nobody asked for this frame, so a failure
        // costs one frame and says nothing to the user.
        captureError(cause, { context: ERROR_CONTEXT, bestEffort: true });
      }
    },
    [assistantId, hold],
  );

  /**
   * Clear the session's slot, because the viewfinder that fed it is gone.
   *
   * Without this a frame from a camera the user closed would still ride the
   * next thing they say. A send that cannot go out (a reconnect gap) is logged
   * and dropped: the session's own close reclaims whatever is parked, so the
   * cost is a stale frame on one turn rather than a leak.
   *
   * A session already over is the common way this runs, since ending a call
   * unmounts the room. There is nothing to say to it, and its close has the
   * slot, so that path is silent rather than reported as a failed unpark.
   */
  const unparkHeldFrame = useCallback(() => {
    const held = heldRef.current;
    if (!held) {
      return;
    }
    hold(null);
    const { sessionGeneration } = useLiveVoiceStore.getState();
    if (sessionGeneration !== held.sessionGeneration) {
      return;
    }
    if (!attachLiveVoiceFrame(null, held.sessionGeneration)) {
      console.warn("live-voice sight: could not unpark the parked frame");
    }
  }, [hold]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const gate = createFrameGate(DEFAULT_FRAME_GATE_OPTIONS);
    gate.reset(performance.now());
    gateRef.current = gate;
    const sampler = createFrameSampler({
      gate,
      onDecision: (decision) => {
        if (!decision.keep) {
          return;
        }
        void captureAndHold(video);
      },
    });
    sampler.start(video);
    return () => {
      captureEpochRef.current += 1;
      sampler.stop();
      gateRef.current = null;
      unparkHeldFrame();
    };
  }, [active, captureAndHold, unparkHeldFrame, videoRef]);

  // A flip points the camera somewhere else entirely and mirrors it, so every
  // score against the old baseline is meaningless and every capture still
  // encoding belongs to the camera that is gone. The sampler keeps running: it
  // is the same element, only the stream behind it changed.
  //
  // The frame ALREADY parked is the old camera's view, and the exposure warmup
  // plus the gate's rate floor put the replacement seconds away, so leaving it
  // staged would let a turn carry the view the user just turned away from. An
  // empty slot until the new camera's first keep is the honest state. On mount
  // there is nothing parked and this is a no-op.
  useEffect(() => {
    captureEpochRef.current += 1;
    unparkHeldFrame();
    gateRef.current?.reset(performance.now());
  }, [facing, unparkHeldFrame]);

  // A retryable transport close ends the SERVER-side session, whose close path
  // reclaims the parked frame, while the logical call (and so
  // `sessionGeneration`) deliberately survives the gap. The fresh session's
  // slot is therefore empty and the id being held points at a row the daemon
  // has already deleted, so the thumbnail would keep claiming a view nothing
  // holds until the gate's heartbeat replaced it.
  //
  // Nothing is sent: there is no slot to unpark, and re-parking the old id
  // would earn the refusal a deleted attachment deserves. The gate is reset so
  // the new session gets a frame as soon as the camera settles rather than
  // waiting out a novelty comparison against a baseline nobody can see.
  //
  // The flag is the narrowest signal for it: only the transport's `closed`
  // handler raises it, and it is lowered again on the `ready` that means a
  // fresh session exists. This effect re-runs only when it changes, so the
  // early return is what confines the work to the transition INTO the gap:
  // coming back out of one must not clear a frame parked since.
  //
  // The epoch bump is for the upload still in flight when the transport
  // dropped: the generation survives the gap by design, so it can resolve
  // after the fresh session is ready with every other guard passing, and with
  // nothing held to outrank it a view from seconds before the gap would be
  // parked as the current one.
  const reconnecting = useLiveVoiceStore.use.reconnecting();
  useEffect(() => {
    if (!reconnecting) {
      return;
    }
    captureEpochRef.current += 1;
    hold(null);
    gateRef.current?.reset(performance.now());
  }, [hold, reconnecting]);

  return { heldFrame };
}
