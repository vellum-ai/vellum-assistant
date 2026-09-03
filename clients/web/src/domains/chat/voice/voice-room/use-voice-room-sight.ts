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
 * frame is encoded afterwards. Everything past the JPEG (the order, the
 * consent, the upload, the send) is `live-voice/sight-capture.ts`, which the
 * session's own camera shares.
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
  isLiveVoiceUserSpeaking,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { createSightCapture } from "@/domains/chat/voice/live-voice/sight-capture";
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
} from "@/lib/camera/frame-gate-debug";
import { createFrameSampler } from "@/lib/camera/frame-sampler";
import {
  createNativeFrameSource,
  type NativeFrameSource,
} from "@/lib/camera/native-frame-source";
import { captureNativeVoiceCameraSample } from "@/runtime/native-voice-camera";
import { haptic } from "@/utils/haptics";

import {
  captureVideoFrame,
  NATIVE_CAPTURE_QUALITY,
  type VoiceCameraFacing,
} from "./voice-camera";

/** Where a failure is filed, so the tag reads the same from every path. */
const ERROR_CONTEXT = "voice-room sight: sample/upload frame";

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
   * The order, the consent and the upload of every keep, shared with the
   * session's own camera. One for the room's whole life: the assistant is
   * handed to each capture by the run that kept the frame, and each session
   * re-bases the order below, so nothing about it is per render.
   */
  const [sight] = useState(() => createSightCapture(ERROR_CONTEXT));

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
   * sampler cleanup behind this hands their uploads back.
   */
  const revokeCaptureConsent = useCallback(() => {
    sight.revokeConsent();
  }, [sight]);

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
    sight.invalidate();
    hold(null);
    gateRef.current?.reset(performance.now());
    nativeSourceRef.current?.invalidate();
  }, [hold, sight]);

  useEffect(() => {
    // `liveAvailable`, and so `active`, already has an assistant in it; the
    // second test is for the narrowing.
    if (!active || assistantId === null) {
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
    sight.grantConsent();
    /**
     * Put a frame the call was given on screen.
     *
     * The haptic is the one beat on this path the user cannot watch for: Live
     * is held at arm's length, aimed at the scene rather than at the
     * thumbnail. It fires here, after the send is accepted, because this is
     * where a frame becomes one the call was given; every frame a guard
     * refuses stays silent.
     */
    const onShared = ({
      attachmentId,
      frame,
    }: {
      attachmentId: string;
      frame: File;
    }): void => {
      void haptic.light();
      hold({ attachmentId, previewUrl: URL.createObjectURL(frame) });
    };
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
          void sight.capture({
            assistantId,
            produceFrame: (filename) => captureVideoFrame(video, filename),
            onShared,
          });
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
          void sight.capture({
            assistantId,
            produceFrame: async (filename) =>
              new File([sample], filename, { type: "image/jpeg" }),
            onShared,
          });
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
      sight.revokeConsent();
      sight.rebaseSendOrder();
      stopSampling();
      gateRef.current = null;
      nativeSourceRef.current = null;
      hold(null);
    };
  }, [active, assistantId, hold, nativePreview, sight, videoRef]);

  /**
   * Whether the user is part-way through saying something, as the session
   * reports it.
   *
   * Two sessions, two signals, and no third opinion about either: hands-free
   * runs on the server VAD, whose boundary the store publishes as
   * `utteranceOpen`, and a manual session has no VAD at all, so the thing that
   * opens the user's turn is the session reaching `listening`, which is where
   * push-to-talk starts forwarding audio. The same fields the status pill's dot
   * is read from, because there is one answer to "is the user talking" and it
   * is the session's.
   */
  const sessionState = useLiveVoiceStore.use.state();
  const handsFree = useLiveVoiceStore.use.handsFree();
  const utteranceOpen = useLiveVoiceStore.use.utteranceOpen();
  const muted = useLiveVoiceStore.use.muted();
  const userSpeaking = isLiveVoiceUserSpeaking({
    state: sessionState,
    handsFree,
    utteranceOpen,
  });

  /**
   * Ask the gate for a frame of the scene the user is starting to talk about.
   *
   * The keep the gate would make on its own is of whatever it last thought was
   * worth sending, and the daemon snapshots the conversation the instant the
   * utterance closes. So a question asked right after the camera moved is
   * answered about the scene before it, every time: the frame of the new one
   * either has not been kept yet or is still uploading. Arming at the START of
   * the question gives that frame the whole spoken sentence to land in.
   *
   * The rising edge only, so one keep per utterance however many store writes
   * land inside it. The keep itself goes through the sampler's own
   * `onDecision`, so consent, capture order, the upload and the thumbnail are
   * the ones every other keep gets rather than a second path beside them.
   *
   * The last reading is tracked whether or not Live is running, which is what
   * makes entering Live mid-sentence quiet: the edge already happened, and the
   * fresh gate's first keep covers that scene anyway.
   */
  const userSpeakingRef = useRef(false);
  useEffect(() => {
    const wasSpeaking = userSpeakingRef.current;
    userSpeakingRef.current = userSpeaking;
    if (!active || wasSpeaking || !userSpeaking) {
      return;
    }
    // A muted mic is a session hearing silence, so nothing is being asked and
    // a frame kept for it would answer nobody. Checked here rather than folded
    // into the reading above, so unmuting mid-sentence is not a second edge.
    if (muted) {
      return;
    }
    gateRef.current?.armForcedKeep(performance.now());
    // The browser sampler needs no nudge: its next candidate frame is one
    // video frame away and will consume the arm on its own.
    nativeSourceRef.current?.sampleNow();
  }, [active, muted, userSpeaking]);

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
    sight.rebaseSendOrder();
  }, [sight, sessionGeneration]);

  const reconnecting = useLiveVoiceStore.use.reconnecting();
  useEffect(() => {
    if (!reconnecting) {
      return;
    }
    invalidateCaptures();
  }, [invalidateCaptures, reconnecting]);

  return { heldFrame, liveAvailable, live, setLive, revokeCaptureConsent };
}
