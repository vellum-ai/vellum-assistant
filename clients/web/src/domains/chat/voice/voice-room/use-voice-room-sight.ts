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

import { uploadChatAttachment } from "@/domains/chat/api/messages";
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
   * Which camera this is. Bumped when sampling stops and when the camera
   * flips, so a capture that was already encoding can tell that the view it
   * came from is gone.
   *
   * The session generation does not cover either case: both leave the call
   * running, and a flip deliberately keeps the sampler on the same element, so
   * a front-camera frame could otherwise be parked as the rear camera's view.
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
        if (
          useLiveVoiceStore.getState().sessionGeneration !== sessionGeneration
        ) {
          return;
        }
        // The camera this came from is closed or pointing elsewhere, so this
        // is a view of nothing the user is looking at now.
        if (captureEpoch !== captureEpochRef.current) {
          return;
        }
        // Latest wins by CAPTURE time, not by resolve order: two uploads can be
        // in flight and the slower one is not the newer view. Losing here is
        // the whole cost of a superseded frame, so it is simply dropped.
        const held = heldRef.current;
        if (held && held.atMs >= atMs) {
          return;
        }
        // Parked before it is shown, and shown only if it was parked. The
        // thumbnail claims the call can see this frame, and during a reconnect
        // gap it cannot: what stays on screen is then the older frame the
        // session's slot really does hold.
        if (!attachLiveVoiceFrame(uploaded.id, sessionGeneration)) {
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
  useEffect(() => {
    captureEpochRef.current += 1;
    gateRef.current?.reset(performance.now());
  }, [facing]);

  return { heldFrame };
}
