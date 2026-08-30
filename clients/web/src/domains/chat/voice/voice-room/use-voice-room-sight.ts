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
 * says which frames are worth keeping. Each keep is uploaded IMMEDIATELY and
 * the returned id is held, one slot, newest wins. When the server VAD closes an
 * utterance, the held id is parked on the session with `attach_frame` and the
 * turn that follows carries it.
 *
 * Uploading on the keep rather than at the utterance end is the whole timing
 * argument. The turn starts the moment the utterance closes; an upload begun
 * there races it and usually loses, and the frame would ride the turn after the
 * one it belonged to. Uploading early costs an attachment for every keep that
 * never rides a turn, which is accepted: the daemon reclaims a parked frame it
 * displaces, and an orphan is a few tens of kilobytes.
 *
 * ## Why the utterance-end EVENT, not the store flag
 *
 * `utteranceOpen` in the live-voice store closes for discarded utterances too,
 * a cough or a door, which never become turns. Parking a frame for one of those
 * would attach it to whatever the user said next instead. Only the transport
 * can tell them apart, so this rides `onLiveVoiceUtteranceEnd`.
 *
 * ## Consent
 *
 * There is no second camera and no hidden one. This samples the viewfinder the
 * room already put on screen, so frames flow exactly while the user can see
 * what is being sampled, and closing the viewfinder stops them.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { uploadChatAttachment } from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import {
  attachLiveVoiceFrame,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { onLiveVoiceUtteranceEnd } from "@/domains/chat/voice/live-voice/use-live-voice";
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

/** The frame the room is holding for the next turn. */
export interface VoiceRoomSightFrame {
  /** Id from the upload, which is what `attach_frame` parks. */
  readonly attachmentId: string;
  /** When the frame was taken, on the clock the staleness check reads. */
  readonly atMs: number;
  /** Object URL of the captured frame. Revoked when the frame is dropped. */
  readonly previewUrl: string;
}

export interface VoiceRoomSight {
  /**
   * The frame waiting to ride the next turn, or null when nothing is held.
   *
   * The feature's only visible sign. Frames leave with turns the user did not
   * ask to send anything on, so what is being sent has to be on screen while it
   * is still true.
   */
  readonly heldFrame: VoiceRoomSightFrame | null;
}

export interface VoiceRoomSightOptions {
  /** Whether the room's viewfinder is up. Nothing is sampled while it is not. */
  readonly cameraOpen: boolean;
  /** Which way the camera points, so a flip can invalidate the gate. */
  readonly facing: VoiceCameraFacing;
}

/** A held frame plus the bookkeeping the render surface has no use for. */
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
  // What the utterance-end listener reads. The listener is registered once per
  // open viewfinder and fires from the transport, so it cannot close over a
  // render's value.
  const heldRef = useRef<HeldFrame | null>(null);
  const gateRef = useRef<FrameGate | null>(null);
  const frameCountRef = useRef(0);

  // All three, so the feature is absent rather than half-present: no camera on
  // screen is no consent, a flag off is not shipped, and an assistant that
  // predates `attach_frame` answers every one with the error code the
  // transport reads as a settings rejection.
  const active =
    cameraOpen && isVisionModeOn(visionMode) && supportsFrames && !!assistantId;

  /**
   * Replace the held frame, giving back whatever it displaced. Revoking is not
   * bookkeeping: each preview holds a decoded full-resolution frame alive, and
   * a long call keeps a frame every few seconds.
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
      // outlive the session the frame was taken in, and a frame from an ended
      // session must not land on whichever session is running when it resolves.
      const sessionGeneration = useLiveVoiceStore.getState().sessionGeneration;
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
        // Latest wins by CAPTURE time, not by resolve order: two uploads can be
        // in flight and the slower one is not the newer view. Losing here is
        // the whole cost of a superseded frame, so it is simply dropped.
        const held = heldRef.current;
        if (held && held.atMs >= atMs) {
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
   * Park the held frame on the turn the closing utterance is becoming.
   *
   * Send and forget: the turn starts either way, and a frame is ambient
   * context rather than something the user pressed a button to send.
   */
  const parkHeldFrame = useCallback(() => {
    const held = heldRef.current;
    if (!held) {
      return;
    }
    // A frame older than the gate's heartbeat cannot be current: the gate keeps
    // one at least that often while a camera is open and settled, so the only
    // way to be holding an older one is that sampling stopped. Sending it would
    // describe a view the camera has since left.
    if (Date.now() - held.atMs > DEFAULT_FRAME_GATE_OPTIONS.maxIntervalMs) {
      return;
    }
    if (attachLiveVoiceFrame(held.attachmentId, held.sessionGeneration)) {
      // One turn per frame. Left held, the next utterance would park an id the
      // daemon has already consumed and reclaimed.
      hold(null);
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
      sampler.stop();
      gateRef.current = null;
      // The camera is gone, so nothing can refresh what is being held, and the
      // preview would outlive the surface drawing it.
      hold(null);
    };
  }, [active, captureAndHold, hold, videoRef]);

  // A flip points the camera somewhere else entirely and mirrors it, so every
  // score against the old baseline is meaningless. The sampler keeps running:
  // it is the same element, only the stream behind it changed.
  useEffect(() => {
    gateRef.current?.reset(performance.now());
  }, [facing]);

  useEffect(() => {
    if (!active) {
      return;
    }
    return onLiveVoiceUtteranceEnd(parkHeldFrame);
  }, [active, parkHeldFrame]);

  return { heldFrame };
}
