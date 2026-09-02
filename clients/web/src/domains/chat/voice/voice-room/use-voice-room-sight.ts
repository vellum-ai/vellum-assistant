/**
 * Sight in the voice room: Live mode, where the open viewfinder feeds the call
 * what it can see without anyone pressing anything further.
 *
 * A tap on the shutter answers "look at this". Live answers "here is what I am
 * holding while I talk about it", which is a different interaction and cannot
 * be built out of shutter presses: the frame has to be in hand before the
 * sentence ends, and a person describing an object is not free to also operate
 * a camera.
 *
 * Live is entered by holding the shutter and left by tapping it, and this hook
 * owns the flag. It already computes the conjunction that says whether Live can
 * be offered at all, and it is the thing that has to stop the moment the
 * viewfinder closes; a flag kept anywhere else would be a second answer to both
 * questions, free to disagree with the sampler it is supposed to describe. Its
 * scope is the room's, so the mode dies with the room.
 *
 * ## The shape of it
 *
 * The gate (`lib/camera/frame-gate.ts`) says which frames are worth keeping.
 * What it is fed depends on which viewfinder is up: the room's own `<video>` in
 * a browser, and behind the native shells' preview layer a poll of the camera
 * plugin's own sample call, decoded through the same downscale chain so one set
 * of thresholds serves both. Every keep is uploaded at once and sent to the
 * session with `sight_frame`, which the daemon persists as its own user
 * message. The transcript is therefore the record of what the call has seen,
 * in the order it saw it, and the model correlates a frame with speech by
 * adjacency rather than by any attachment to a turn.
 *
 * The native path keeps the very JPEG the gate judged rather than capturing a
 * second one, so what the transcript holds is the frame the decision was about.
 * The browser path cannot: its decision is made on a canvas readback, and the
 * frame is encoded afterwards.
 *
 * ## What a shell with no sample call does
 *
 * Live is offered wherever the native preview is up, without asking the bridge
 * anything first. The preview is up only because the camera plugin accepted a
 * start, the sample call ships in that same plugin, and both shells load this
 * bundle from the network, so a shell that has one call and not the other is a
 * population of about nobody. A shell whose samples answer nothing anyway runs
 * Live and keeps nothing: the pill is on, the poll turns, and no frame reaches
 * the transcript, which is the same shape as a scene the gate never judges
 * worth keeping and costs a poll rather than an error surface.
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
 * room already put on screen, and only after the user has held the shutter to
 * ask for it, so frames flow exactly while the user can see what is being
 * sampled and has said to. Each one lands somewhere they can see it and delete
 * it. Tapping the shutter again, closing the viewfinder, and putting the app
 * away all stop them at once, and the last of those costs another hold to
 * start again rather than resuming on the gesture that came before it.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  deleteChatAttachment,
  uploadChatAttachment,
} from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import {
  sendLiveVoiceSightFrame,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  isVisionModeOn,
  useVisionModeVariant,
} from "@/hooks/use-vision-mode-flag";
import { useSupportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
import { type FrameGate, createFrameGate } from "@/lib/camera/frame-gate";
import {
  FRAME_GATE_LIVE_OPTIONS,
  recordFrameGateDecision,
  recordFrameGateKeep,
} from "@/lib/camera/frame-gate-debug";
import { createFrameSampler } from "@/lib/camera/frame-sampler";
import {
  createNativeFrameSource,
  type NativeFrameSource,
} from "@/lib/camera/native-frame-source";
import { captureError } from "@/lib/sentry/capture-error";
import { captureNativeVoiceCameraSample } from "@/runtime/native-voice-camera";
import { haptic } from "@/utils/haptics";

import {
  captureVideoFrame,
  NATIVE_CAPTURE_QUALITY,
  type VoiceCameraFacing,
} from "./voice-camera";

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
  /**
   * Whether Live can be entered at all: the flag, an assistant, that
   * assistant understanding the frame, and a session that has not latched the
   * frame as unsupported. The room reads it to decide whether to offer the hold
   * and the hint, so an unavailable Live is a shutter that only takes photos
   * rather than one that takes a hold and does nothing with it.
   */
  readonly liveAvailable: boolean;
  /** Whether the viewfinder is streaming. Only then is anything sampled. */
  readonly live: boolean;
  /**
   * Enter or leave Live. Forced back off when the viewfinder closes, when
   * availability goes, and when the app is put into the background, so nothing
   * can display Live over a camera sampling nothing and no gesture carries
   * across a backgrounding.
   */
  readonly setLive: (live: boolean) => void;
  /**
   * Withdraw consent from every frame captured but not yet shared, now.
   *
   * For the acts that end the viewfinder without going through `setLive`: the
   * camera control's close is one press to the user and two facts to the app,
   * and the mode coming down behind it is a render too late for a frame whose
   * upload lands in between. Callers that close the camera call this first, in
   * the same handler. Idempotent, and free when nothing is being sampled.
   */
  readonly revokeCaptureConsent: () => void;
}

export interface VoiceRoomSightOptions {
  /** Whether the room's viewfinder is up. Nothing is sampled while it is not. */
  readonly cameraOpen: boolean;
  /** Which way the camera points, so a flip can invalidate the gate. */
  readonly facing: VoiceCameraFacing;
  /**
   * Whether the viewfinder on screen is the native shells' preview layer.
   *
   * It sits behind the web view and mounts no `<video>`, so it is sampled
   * through the camera plugin instead of the room's element. Which preview is
   * up is decided per acquire and can change mid-viewfinder: a shell whose
   * native start failed runs the browser fallback, and a later flip retries the
   * native one.
   */
  readonly nativePreview: boolean;
}

export function useVoiceRoomSight(
  assistantId: string | null,
  /** The room's own ref for the viewfinder `<video>`. */
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { cameraOpen, facing, nativePreview }: VoiceRoomSightOptions,
): VoiceRoomSight {
  const visionMode = useVisionModeVariant();
  const supportsFrames = useSupportsSightStream(assistantId);
  // An assistant that refuses the frame at all, latched for the session. Read
  // here rather than beside the effect that acts on it, because it is one of
  // the terms in whether Live can be offered at all: see `liveAvailable`.
  const sightFramesUnsupported = useLiveVoiceStore.use.sightFramesUnsupported();
  const [heldFrame, setHeldFrame] = useState<VoiceRoomSightFrame | null>(null);
  const [live, setLiveState] = useState(false);
  // What the capture continuations read. The sampler outlives a render, so it
  // cannot close over a render's value.
  const heldRef = useRef<VoiceRoomSightFrame | null>(null);
  const gateRef = useRef<FrameGate | null>(null);
  /**
   * The running native poll, so a change it cannot see can reach the sample it
   * has on the bridge.
   *
   * Null on the browser path, which has nothing to be told: that sampler
   * encodes its frame from the element when the gate keeps one, so the picture
   * and the decision are of the same moment and a flip is already in both.
   */
  const nativeSourceRef = useRef<NativeFrameSource | null>(null);
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
   * Which camera and transport this capture chain feeds. Bumped when consent
   * is withdrawn, when sampling stops, when the camera flips, and when the
   * transport drops into a reconnect, so a capture that was already encoding
   * can tell that the world it was headed for is gone.
   *
   * The session generation covers none of them: each leaves the logical call
   * running, a flip deliberately keeps the sampler on the same element,
   * and a reconnect deliberately keeps the generation, so a stalled upload
   * from before any of them could otherwise be persisted as a view of what the
   * call is looking at.
   */
  const captureEpochRef = useRef(0);
  /**
   * Whether what the loop is producing right now is still consented to.
   *
   * `active` says the same thing a render later, which is a render too late
   * for a boundary: the sampler's own callbacks and the uploads it has started
   * both run inside the gap between the tap and the effect that stops it.
   * Raised where a sampling run starts, lowered the moment consent goes.
   */
  const captureConsentedRef = useRef(false);

  /**
   * Take consent back from every frame the camera has produced but not yet
   * shared, in the same tick as the act that takes it back.
   *
   * Ending Live only schedules a re-render, and the sampler effect's cleanup
   * runs after it. An epoch left to that cleanup is one an upload resolving in
   * the gap still matches, so the frame passes the guard it is checked against
   * and is shared with the call after the user has said stop. The bump belongs
   * here instead: every capture already started fails the guard on its way
   * out, and the flag stops one the loop would otherwise begin before it is
   * torn down.
   *
   * There are two tiers of caller, and the difference is whether a user acted.
   * An act (the shutter's stop, the camera control's close, the app being put
   * away) revokes in the handler itself, which is the only place with no gap
   * at all. Everything state-derived (availability going, a flip that failed
   * its way out of the viewfinder) has no such tick to sit in, so it revokes at
   * the earliest point a hook offers, the commit
   * that carries the change, before paint and before the effect that lowers
   * the mode. Neither is the user withdrawing consent, so a frame crossing
   * that narrower window is a stale view rather than a broken promise.
   *
   * Parked sends are left to refuse themselves at that same guard, and the
   * sampler cleanup behind this hands their uploads back. Nothing but a real
   * sampling run to revoke gets past the first line, so a refused raise, a
   * stop of something already stopped, and an ordinary re-render all cost
   * nothing: an epoch churned for one of those would void a capture nobody
   * withdrew.
   */
  const revokeCaptureConsent = useCallback(() => {
    if (!captureConsentedRef.current) {
      return;
    }
    captureConsentedRef.current = false;
    captureEpochRef.current += 1;
  }, []);

  // All four, so the feature is absent rather than half-present: a flag off is
  // not shipped, an assistant that predates `sight_frame` answers every keep
  // with the error code the transport reads as a settings rejection, without an
  // assistant there is nothing to upload against, and a session that has
  // latched the frame as unsupported drops every keep at the capture guard
  // below. Which viewfinder is up is not among them: both have a source, and
  // the effect below picks between them. Each belongs in the offer and not only
  // in the state: taking Live down while leaving the hold on the shutter is a
  // gesture that raises a pill saying Live over a camera nothing is reading.
  // Availability is also what the mode is held to, by the effect below, so a
  // term going false mid-viewfinder ends a Live that is already running rather
  // than stranding it.
  const liveAvailable =
    isVisionModeOn(visionMode) &&
    supportsFrames &&
    !!assistantId &&
    !sightFramesUnsupported;
  // The camera on screen is the consent, and Live is the ask. Nothing samples
  // without both.
  const active = cameraOpen && liveAvailable && live;

  /**
   * What an ask to enter Live is refused against, read when the ask arrives
   * rather than closed over by whoever holds the setter.
   *
   * An ask can outlive the render that handed out the setter: the room builds
   * the shutter's hold handler around one, and the shutter's own threshold
   * fires that handler half a second after it was given. Availability can go
   * inside that half second, and a setter answering from what it captured
   * would raise Live past the effect below, which has already run for the
   * change and does not re-run for the write.
   *
   * Written in a commit-phase effect rather than during render, so the answer
   * always describes UI that was actually shown.
   */
  const liveAllowedRef = useRef(false);
  useLayoutEffect(() => {
    liveAllowedRef.current = cameraOpen && liveAvailable;
  });

  /**
   * Enter or leave Live, where entering is refused unless it is available.
   *
   * The effect below cannot answer this one: its deps are the availability it
   * watches, so a request made while Live is already unavailable changes
   * nothing it re-runs on and would leave the flag raised until the next real
   * transition. The refusal belongs at the ask.
   *
   * Leaving takes consent with it here rather than in the render that follows,
   * for the reason `revokeCaptureConsent` gives: the tap is the boundary, not
   * the commit after it.
   */
  const setLive = useCallback(
    (next: boolean) => {
      if (!next) {
        revokeCaptureConsent();
      }
      setLiveState(next && liveAllowedRef.current);
    },
    [revokeCaptureConsent],
  );

  // Live never outlives what makes it honest. The viewfinder closing takes the
  // consent away, and availability going (a flag, an assistant, the latch)
  // takes the destination away, so in either case the mode goes back to photo
  // rather than staying raised over a camera nothing can act on.
  useEffect(() => {
    if (cameraOpen && liveAvailable) {
      return;
    }
    setLiveState(false);
  }, [cameraOpen, liveAvailable]);

  // The same ending, taken at the commit rather than after it. Every way the
  // viewfinder or the destination can go without the user acting arrives as
  // one of these two values changing: a flip that failed its way out of the
  // camera, the latch, the flag, the assistant unbinding. None has a handler to
  // be synchronous with, so this is the
  // earliest they can be answered, a paint and a passive flush ahead of the
  // effect above. The user's own acts do not wait for it.
  useLayoutEffect(() => {
    if (cameraOpen && liveAvailable) {
      return;
    }
    revokeCaptureConsent();
  }, [cameraOpen, liveAvailable, revokeCaptureConsent]);

  // Backgrounding ends Live, rather than pausing it, and this is where both
  // sources learn that the app went away.
  //
  // The hold is the consent, and it is given to a viewfinder the user is
  // watching. Neither source stops itself: one pauses its loop while the page
  // is hidden and picks it back up on the way in, the other polls a bridge that
  // has no opinion about the app being on screen. A Live that survived a
  // backgrounding would therefore resume sharing what the camera sees on a
  // gesture made before the app was put away. Coming back to a viewfinder on
  // photo costs one hold; coming back to one that is already streaming costs
  // whatever it captured first.
  //
  // The revocation is synchronous with the edge; lowering the mode stops the
  // source only when React's next commit runs the sampling effect's cleanup.
  // The revocation is what covers that window: every capture path reads it
  // before it takes or shares a frame.
  //
  // The bus's own edge rather than a `visibilitychange` listener here: it is
  // published once per physical edge from the two sources that describe it,
  // which is what the mobile shells need, since they can report a background
  // with no DOM event at all (see docs/EVENT_BUS.md, and the composer's sight
  // store, which gives its camera back on the same event).
  useBusSubscription("app.hidden", () => {
    revokeCaptureConsent();
    setLiveState(false);
  });

  // Dismissing the room ends Live too, and for the same reason: the viewfinder
  // the consent was given to is gone, and the room coming back is a fresh ask.
  //
  // It cannot be left to the teardown. The overlay plays an exit animation
  // before it unmounts, so the sampler cleanup behind a dismissal is a whole
  // animation away, and a frame whose upload lands inside it would be shared
  // with the call after the user put the room away. Lowering the mode as well
  // as revoking is what keeps a dismissal the user takes back mid-animation
  // honest: the room returns on photo rather than to a stream whose consent
  // has already been spent.
  //
  // The store rather than a wrapped control, which is the shape the camera's
  // close could not have: the chevron, Escape, the sheet's own drag, an
  // assistant-driven `minimize_room` frame and the reconnect path all reach
  // one `set()`, and zustand runs its subscribers inside it, so this lands in
  // the tick the user acted in with no wrapper for a caller to miss.
  useEffect(() => {
    return useLiveVoiceStore.subscribe((state, previous) => {
      if (!state.roomMinimized || previous.roomMinimized) {
        return;
      }
      revokeCaptureConsent();
      setLiveState(false);
    });
  }, [revokeCaptureConsent]);

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

  /**
   * Take one kept frame all the way to the transcript and the pulse.
   *
   * Everything past the frame itself is the same on both paths: the same
   * guards, the same order, the same upload, the same send, the same preview
   * lifecycle. Only where the JPEG comes from differs, so that is what the
   * caller supplies: the browser path encodes the `<video>` it is watching, the
   * native path wraps the sample the gate has already judged.
   */
  const captureAndHold = useCallback(
    async (produceFrame: (filename: string) => Promise<File | null>) => {
      if (!assistantId) {
        return;
      }
      // Consent is already gone, and the loop has not been torn down yet. The
      // epoch cannot speak for this one: a capture beginning after the bump
      // reads the new number and would pass the guard on the way out, so a
      // frame taken after the user said stop is refused before it is taken.
      if (!captureConsentedRef.current) {
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
        const frame = await produceFrame(`sight-${frameCountRef.current}.jpg`);
        if (!frame) {
          return;
        }
        recordFrameGateKeep("voice", frame);

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
            // The one beat on this path the user cannot watch for: Live is
            // held at arm's length, aimed at the scene rather than at the
            // thumbnail. It fires here, after the send is accepted, because
            // this is where a frame becomes one the call was given; every
            // frame a guard refuses reaches `abandonUpload` above and stays
            // silent.
            void haptic.light();
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
   * encoding, the sample still crossing the bridge, the view on screen, and the
   * gate's baseline.
   *
   * The bridge is the one the epoch cannot speak for on its own. A capture
   * stamps itself with the epoch when the gate KEEPS a frame, which on the
   * native path is after the sample was taken: the bytes are of the old camera
   * and the stamp is of the new world, so the frame passes every guard on the
   * way out and is persisted as what the call is looking at now. Only the
   * source knows when it asked for those bytes, so it is the source that
   * refuses them.
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
    nativeSourceRef.current?.invalidate();
  }, [hold, rebaseSendOrder]);

  useEffect(() => {
    if (!active) {
      return;
    }
    // The native preview mounts no element, so the element is the browser
    // path's premise and not the run's: reading it there and only there is what
    // lets one effect drive both sources.
    const video = nativePreview ? null : videoRef.current;
    if (!nativePreview && !video) {
      return;
    }
    // The run this consent was given for. Raised here rather than derived from
    // `active`, which a capture in a torn-down loop still reads as the value of
    // the render it started in.
    captureConsentedRef.current = true;
    // The live options record rather than the defaults, so the tuning readout
    // can move a threshold without this effect rebuilding the gate. A rebuild
    // would clear the last-keep clock and fire an immediate keep, which on
    // this surface is an upload and a persisted transcript message.
    const gate = createFrameGate(FRAME_GATE_LIVE_OPTIONS);
    gate.reset(performance.now());
    gateRef.current = gate;

    let stopSampling: () => void;
    if (video) {
      const sampler = createFrameSampler({
        gate,
        onDecision: (decision, nowMs) => {
          recordFrameGateDecision("voice", decision, nowMs);
          if (!decision.keep) {
            return;
          }
          void captureAndHold((filename) => captureVideoFrame(video, filename));
        },
      });
      sampler.start(video);
      stopSampling = sampler.stop;
    } else {
      const source = createNativeFrameSource({
        gate,
        captureSample: () =>
          captureNativeVoiceCameraSample(NATIVE_CAPTURE_QUALITY),
        onDecision: (decision, nowMs, sample) => {
          recordFrameGateDecision("voice", decision, nowMs);
          if (!decision.keep) {
            return;
          }
          // The judged bytes, not a second capture: one round trip, and the
          // frame the transcript ends up with is the one the gate said yes to.
          void captureAndHold(
            async (filename) =>
              new File([sample], filename, { type: "image/jpeg" }),
          );
        },
      });
      source.start();
      nativeSourceRef.current = source;
      stopSampling = source.stop;
    }
    return () => {
      // What voids the work in flight for every other way a run can end: an
      // unmount, a closed room, a viewfinder swapped under it, the app being
      // put away. The revocation is the bump, so a run the user ended finds it
      // already spent and this is a no-op against captures that have failed
      // their guard once already.
      revokeCaptureConsent();
      rebaseSendOrder();
      stopSampling();
      gateRef.current = null;
      nativeSourceRef.current = null;
      hold(null);
    };
  }, [
    active,
    captureAndHold,
    hold,
    nativePreview,
    rebaseSendOrder,
    revokeCaptureConsent,
    videoRef,
  ]);

  // A flip points the camera somewhere else entirely and mirrors it, so every
  // score against the old baseline is meaningless and every capture still
  // encoding belongs to the camera that is gone. The source keeps running: on
  // the browser path it is the same element with a new stream behind it, and on
  // the native path the poll never knew which camera it was reading, so it
  // needs the sample it is holding refused rather than the cadence broken.
  //
  // The frame on screen is the old camera's view, and the exposure warmup plus
  // the gate's rate floor put the replacement seconds away, so leaving it up
  // would show the user's own face as what the call is being shown of the room
  // in front of them. On mount nothing is held and this is a no-op.
  //
  // A preview swapping between the element and the native layer needs nothing
  // here: the sampling effect below re-runs for it, and its teardown voids the
  // captures, rebases the order and drops the pulse on the way past.
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
  //
  // Only the thumbnail here. The mode comes down through `liveAvailable`, which
  // the latch is a term of, so a Live that is running when it rises is ended by
  // the same effect that ends one whose flag or assistant went away.
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

  return { heldFrame, liveAvailable, live, setLive, revokeCaptureConsent };
}
