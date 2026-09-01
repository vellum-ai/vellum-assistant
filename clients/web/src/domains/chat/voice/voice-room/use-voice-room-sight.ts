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
 * says which frames are worth keeping. Every keep is uploaded at once and sent
 * to the session with `sight_frame`, which the daemon persists as its own user
 * message. The transcript is therefore the record of what the call has seen,
 * in the order it saw it, and the model correlates a frame with speech by
 * adjacency rather than by any attachment to a turn.
 *
 * ## Why every keep persists, rather than one staged for the next turn
 *
 * Because there is no boundary the client can act on in time. The daemon closes
 * an utterance and starts the turn in the same call chain, so a frame sent when
 * the client hears `utterance_end` cannot arrive before that turn reads it, and
 * would land on the turn after the one it belonged to. Worse, the boundary is
 * not even a reliable sign a turn is coming: an empty transcript is announced
 * as `utterance_end` and only discovered to be empty later.
 *
 * Persisting on the way past removes the question. Nothing has to be held for a
 * turn that may not come, no keep can be displaced by a newer one before it is
 * seen, and push-to-talk, hands-free and a cough all cost the same. What it
 * costs instead is transcript volume, which retention answers: the daemon tags
 * each keep so the newest few stay images to the model and older ones become
 * timestamped stubs, while the transcript keeps every one.
 *
 * ## Consent
 *
 * There is no second camera and no hidden one. This samples the viewfinder the
 * room already put on screen, so frames flow exactly while the user can see
 * what is being sampled, and each one lands somewhere they can see it and
 * delete it. Closing the viewfinder stops them at once.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteChatAttachment,
  uploadChatAttachment,
} from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import {
  sendLiveVoiceSightFrame,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  isVisionModeOn,
  useVisionModeVariant,
} from "@/hooks/use-vision-mode-flag";
import { useSupportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
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

/**
 * How many finished captures may wait on an unfinished older one.
 *
 * Overlap is naturally shallow: the gate's rate floor is seconds and an upload
 * is not, so at most one or two captures are usually in flight. The cap is for
 * the pathological case, an upload that hangs rather than fails, which would
 * otherwise hold every later keep behind it for the rest of the call. Past the
 * cap the gate gives up on the missing capture and lets the backlog through.
 */
const MAX_PARKED_SIGHT_SENDS = 4;

/** A finished capture waiting for its turn in capture order. */
interface PendingSightSend {
  /** Send it, if the session and the camera it came from are still current. */
  readonly send: () => void;
  /** Give the upload back: this frame will never be sent. */
  readonly discard: () => void;
}

/** The most recent frame the call was given. */
export interface VoiceRoomSightFrame {
  /** Id from the upload, which is what `sight_frame` named. */
  readonly attachmentId: string;
  /** Object URL of the captured frame. Revoked when the frame is dropped. */
  readonly previewUrl: string;
}

export interface VoiceRoomSight {
  /**
   * The newest view shared with the call, or null when none has been.
   *
   * The feature's only visible sign while the room is up. Frames go without
   * anyone pressing anything, so the last one has to be on screen at the
   * moment it is shared rather than only afterwards.
   *
   * It is a pulse, not a claim about what is staged: nothing is. Every keep it
   * has shown is already in the transcript, which is the durable record and
   * the place a user deletes one from.
   */
  readonly heldFrame: VoiceRoomSightFrame | null;
}

export interface VoiceRoomSightOptions {
  /** Whether the room's viewfinder is up. Nothing is sampled while it is not. */
  readonly cameraOpen: boolean;
  /** Which way the camera points, so a flip can invalidate the gate. */
  readonly facing: VoiceCameraFacing;
}

export function useVoiceRoomSight(
  assistantId: string | null,
  /** The room's own ref for the viewfinder `<video>`. */
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { cameraOpen, facing }: VoiceRoomSightOptions,
): VoiceRoomSight {
  const visionMode = useVisionModeVariant();
  const supportsFrames = useSupportsSightStream(assistantId);
  const [heldFrame, setHeldFrame] = useState<VoiceRoomSightFrame | null>(null);
  // What the capture continuations read. The sampler outlives a render, so it
  // cannot close over a render's value.
  const heldRef = useRef<VoiceRoomSightFrame | null>(null);
  const gateRef = useRef<FrameGate | null>(null);
  const frameCountRef = useRef(0);
  /**
   * The ordering gate: sends leave in the order the gate KEPT the frames, not
   * the order their uploads happened to finish.
   *
   * Uploads of overlapping keeps can finish in either order, and the transcript
   * is the record of what the call saw. The model correlates a frame with
   * speech by adjacency, so a scene persisted after a newer one is read as the
   * view the words that follow were about, and there may be no later keep to
   * correct it before the camera closes.
   *
   * `captureSeqRef` hands each capture its number when the gate fires,
   * `nextSendSeqRef` is whose turn it is, and finished captures wait in
   * `parkedSendsRef` until the run of numbers before them is complete. Every
   * exit path settles its number, so a capture that fails, is refused, or is
   * abandoned releases the ones behind it instead of stranding them.
   */
  const captureSeqRef = useRef(0);
  const nextSendSeqRef = useRef(0);
  const parkedSendsRef = useRef(new Map<number, PendingSightSend | null>());
  /**
   * Which camera and transport this capture chain feeds. Bumped when sampling
   * stops, when the camera flips, and when the transport drops into a
   * reconnect, so a capture that was already encoding can tell that the world
   * it was headed for is gone.
   *
   * The session generation covers none of the three: each leaves the logical
   * call running, a flip deliberately keeps the sampler on the same element,
   * and a reconnect deliberately keeps the generation, so a stalled upload
   * from before any of them could otherwise be persisted as a view of what the
   * call is looking at.
   */
  const captureEpochRef = useRef(0);

  // All three, so the feature is absent rather than half-present: no camera on
  // screen is no consent, a flag off is not shipped, and an assistant that
  // predates `sight_frame` answers every one with the error code the transport
  // reads as a settings rejection.
  const active =
    cameraOpen && isVisionModeOn(visionMode) && supportsFrames && !!assistantId;

  /**
   * Replace the frame on screen, giving back whatever preview it displaced.
   * Revoking is not bookkeeping: each preview holds a decoded full-resolution
   * frame alive, and a long call keeps a frame every few seconds.
   */
  const hold = useCallback((next: VoiceRoomSightFrame | null) => {
    const previous = heldRef.current;
    heldRef.current = next;
    setHeldFrame(next);
    if (previous && previous.previewUrl !== next?.previewUrl) {
      URL.revokeObjectURL(previous.previewUrl);
    }
  }, []);

  /**
   * Give an uploaded row back.
   *
   * Nothing else can: an attachment is collected when the message linking it
   * is deleted, or by the daemon reclaiming a frame it could not persist, and
   * an id that reaches neither is a row and its bytes kept for good.
   *
   * Called for the ids this hook refuses itself, before the frame is sent, and
   * for the ids stranded by an assistant with no handler for the frame, which
   * stores nothing and reclaims nothing. NOT called for a frame an assistant
   * that understands it could not persist: that path reclaims on its own, so
   * deleting would race it over a row this hook no longer owns.
   */
  const reclaimUpload = useCallback(
    (attachmentId: string) => {
      if (!assistantId) {
        return;
      }
      void deleteChatAttachment(assistantId, attachmentId).then((ok) => {
        if (!ok) {
          captureError(new Error("sight frame delete refused"), {
            context: ERROR_CONTEXT,
            bestEffort: true,
          });
        }
      });
    },
    [assistantId],
  );

  /**
   * Send everything whose turn has come, oldest first.
   *
   * Stops at the first number nobody has settled yet, because that capture is
   * still encoding or uploading and its frame belongs ahead of these. Once the
   * backlog exceeds the cap the missing capture is written off and the oldest
   * parked number becomes the new turn, so a hung upload costs the frames it
   * overlapped rather than the rest of the call.
   */
  const drainSends = useCallback(() => {
    const parked = parkedSendsRef.current;
    for (;;) {
      while (parked.has(nextSendSeqRef.current)) {
        const pending = parked.get(nextSendSeqRef.current) ?? null;
        parked.delete(nextSendSeqRef.current);
        nextSendSeqRef.current += 1;
        pending?.send();
      }
      if (parked.size <= MAX_PARKED_SIGHT_SENDS) {
        return;
      }
      nextSendSeqRef.current = Math.min(...parked.keys());
    }
  }, []);

  /**
   * Report what became of one capture, whether or not it produced a frame.
   *
   * Called on every exit path, which is what keeps the gate live: a capture
   * that threw, uploaded nothing, or was refused still releases the captures
   * waiting behind it.
   */
  const settleCapture = useCallback(
    (captureSeq: number, pending: PendingSightSend | null) => {
      if (captureSeq < nextSendSeqRef.current) {
        // The gate has moved past this number: the cap wrote it off, or a new
        // session re-based the order. Sending now would put an older view
        // after a newer one, which is the whole thing being prevented.
        pending?.discard();
        return;
      }
      parkedSendsRef.current.set(captureSeq, pending);
      drainSends();
    },
    [drainSends],
  );

  /**
   * Start the order again from whatever has not been captured yet.
   *
   * For the boundaries where waiting on an older capture stops making sense:
   * a new session, a flipped camera, a closed viewfinder. Anything parked is
   * given back rather than sent, since it would fail the guards at send time
   * anyway, and anything still in flight settles below the new turn and is
   * discarded when it lands.
   */
  const rebaseSendOrder = useCallback(() => {
    const parked = parkedSendsRef.current;
    for (const pending of parked.values()) {
      pending?.discard();
    }
    parked.clear();
    nextSendSeqRef.current = captureSeqRef.current;
  }, []);

  const captureAndHold = useCallback(
    async (video: HTMLVideoElement) => {
      if (!assistantId) {
        return;
      }
      // Nothing this assistant is told about lands, and each attempt would
      // strand another upload, so the sampler runs on and every keep is
      // dropped here. See `sightFramesUnsupported` on the live-voice store.
      if (useLiveVoiceStore.getState().sightFramesUnsupported) {
        return;
      }
      // Read before the encode, not after the upload. Everything below can
      // outlive the session and the camera the frame was taken from, and
      // neither can be re-read afterwards without describing the wrong one.
      const sessionGeneration = useLiveVoiceStore.getState().sessionGeneration;
      const captureEpoch = captureEpochRef.current;
      // Taken here, at the moment the gate kept the frame, because that is the
      // order the scenes happened in and the order the transcript has to carry
      // them in. See the ordering-gate refs above.
      const captureSeq = captureSeqRef.current;
      captureSeqRef.current += 1;
      let pending: PendingSightSend | null = null;
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
        const abandonUpload = (): void => reclaimUpload(uploaded.id);
        // The guards run when the turn comes, not now, so a frame that waited
        // is still checked against the session and camera of the moment it
        // would land in.
        pending = {
          discard: abandonUpload,
          send: () => {
            if (
              useLiveVoiceStore.getState().sessionGeneration !==
              sessionGeneration
            ) {
              abandonUpload();
              return;
            }
            // The camera this came from is closed or pointing elsewhere, so
            // this is a view of nothing the user is looking at now, and
            // persisting it would put that view in the transcript as the
            // current one.
            if (captureEpoch !== captureEpochRef.current) {
              abandonUpload();
              return;
            }
            // Sent before it is shown, and shown only if it was sent. The
            // thumbnail says the call has been given this frame, and during a
            // reconnect gap it has not. A frame that never left is this hook's
            // to give back, since the daemon never saw it.
            if (!sendLiveVoiceSightFrame(uploaded.id, sessionGeneration)) {
              abandonUpload();
              return;
            }
            hold({
              attachmentId: uploaded.id,
              previewUrl: URL.createObjectURL(frame),
            });
          },
        };
      } catch (cause) {
        // Best effort by design: nobody asked for this frame, so a failure
        // costs one frame and says nothing to the user.
        captureError(cause, { context: ERROR_CONTEXT, bestEffort: true });
      } finally {
        // Every path, including the ones that produced nothing: a capture that
        // never sends must still release the captures behind it.
        settleCapture(captureSeq, pending);
      }
    },
    [assistantId, hold, reclaimUpload, settleCapture],
  );

  /**
   * Void every capture aimed at the world that just changed: the frames still
   * encoding, the view on screen, and the gate's baseline.
   *
   * Nothing is sent. Keeps already persisted stay in the transcript, which is
   * where the user can see and delete them; this speaks only for the live
   * pulse and for what is still in flight.
   */
  const invalidateCaptures = useCallback(() => {
    captureEpochRef.current += 1;
    rebaseSendOrder();
    hold(null);
    gateRef.current?.reset(performance.now());
  }, [hold, rebaseSendOrder]);

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
      // The epoch bump is what stops a frame from a viewfinder the user has
      // put away being persisted when its upload lands, which is the whole of
      // what closing has to guarantee: nothing is staged for a later turn to
      // pick up, so there is nothing to take back.
      captureEpochRef.current += 1;
      rebaseSendOrder();
      sampler.stop();
      gateRef.current = null;
      hold(null);
    };
  }, [active, captureAndHold, hold, rebaseSendOrder, videoRef]);

  // A flip points the camera somewhere else entirely and mirrors it, so every
  // score against the old baseline is meaningless and every capture still
  // encoding belongs to the camera that is gone. The sampler keeps running: it
  // is the same element, only the stream behind it changed.
  //
  // The frame on screen is the old camera's view, and the exposure warmup plus
  // the gate's rate floor put the replacement seconds away, so leaving it up
  // would show the user's own face as what the call is being shown of the room
  // in front of them. On mount nothing is held and this is a no-op.
  useEffect(() => {
    invalidateCaptures();
  }, [facing, invalidateCaptures]);

  // A retryable transport close ends the SERVER-side session while the logical
  // call (and so `sessionGeneration`) deliberately survives the gap. Keeps
  // already made are in the transcript and stay there, but the pulse tracks
  // the session that is running, and for the length of the gap none is.
  //
  // The flag is the narrowest signal for it: only the transport's `closed`
  // handler raises it, and it is lowered again on the `ready` that means a
  // fresh session exists. This effect re-runs only when it changes, so the
  // early return is what confines the work to the transition INTO the gap:
  // coming back out of one must not clear a frame shared since.
  //
  // The epoch bump is for the upload still in flight when the transport
  // dropped: the generation survives the gap by design, so it can resolve
  // after the fresh session is ready with every other guard passing, and a
  // view from seconds before the gap would be persisted as the current one.
  // A refusal the store could tie to a keep this surface is displaying. Taking
  // the thumbnail down is all it costs here: giving the upload back belongs to
  // the session-lifetime reclaimer, because a minimized room is not mounted
  // and cleanup cannot wait on this component existing.
  const sightFrameRetractions = useLiveVoiceStore.use.sightFrameRetractions();
  useEffect(() => {
    if (sightFrameRetractions.length === 0) {
      return;
    }
    // Taken rather than read-then-cleared, and the taken set is what gets
    // checked rather than the one this render captured. A retraction queued
    // between that render and this effect is inside the take, so it is acted
    // on instead of being cleared unread, which would leave a frame the
    // assistant refused sitting on screen as one it was shown.
    const taken = useLiveVoiceStore.getState().takeSightFrameRetractions();
    const displayed = heldRef.current?.attachmentId;
    if (displayed !== undefined && taken.includes(displayed)) {
      hold(null);
    }
  }, [hold, sightFrameRetractions]);

  // An assistant that cannot take the frame at all is a different case, and a
  // latch rather than an event: nothing it was sent was ever shared, so there
  // is no honest version of the thumbnail to leave up, and no correlation to
  // do to know that.
  const sightFramesUnsupported = useLiveVoiceStore.use.sightFramesUnsupported();
  useEffect(() => {
    if (!sightFramesUnsupported) {
      return;
    }
    hold(null);
  }, [hold, sightFramesUnsupported]);

  // Each session orders its own keeps. A capture from the call before this one
  // must never be the thing a new keep is waiting behind, and anything of its
  // that is still in flight fails the generation guard when it lands anyway.
  // On mount there is nothing captured and nothing parked, so this is a no-op.
  const sessionGeneration = useLiveVoiceStore.use.sessionGeneration();
  useEffect(() => {
    rebaseSendOrder();
  }, [rebaseSendOrder, sessionGeneration]);

  const reconnecting = useLiveVoiceStore.use.reconnecting();
  useEffect(() => {
    if (!reconnecting) {
      return;
    }
    invalidateCaptures();
  }, [invalidateCaptures, reconnecting]);

  return { heldFrame };
}
