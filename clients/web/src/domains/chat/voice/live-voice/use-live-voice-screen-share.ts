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
 * The helper is asked for a frame when the share starts and at each edge of
 * the user's turn: as they start talking and as they stop. The start is the
 * one the turn will read, since the daemon snapshots the conversation the
 * instant the utterance closes (see `use-voice-room-sight.ts`); the end is
 * the view the user left behind, for the turn after. Nothing in between and
 * nothing while nobody is talking.
 *
 * Asked for is not sent. Every frame the cadence takes is judged by the gate
 * the camera runs (`frame-gate.ts`), against the last frame the call was
 * given, and only a keep is uploaded. That is what keeps one utterance from
 * costing two frames of one view: the stop edge of a question asked about an
 * unchanged screen is `unchanged` and goes nowhere. There is no floor between
 * frames for the same reason there is none in the gate: on the camera a floor
 * held the frame of a new view behind the very turn that asked about it. The
 * start edge arms the gate the way speech onset does in the room, so the
 * frame it takes is kept at the lower bar a question earns, and reported
 * `answered` when the last keep already shows the view. The gate's rules
 * that are about a lens are turned off; see
 * {@link SCREEN_SHARE_FRAME_GATE_OPTIONS}. What the gate judges against is
 * the last frame the call was actually given: a keep whose upload fails is
 * put back, so the view it was of is not turned away as one the call has.
 *
 * ## What the assistant can point at
 *
 * Beside the frame, the start of a share, a look and the start of the user's
 * turn each read the controls the surface offers from its accessibility tree
 * (`readCompanionShareTargets`) and hand them to the session on
 * `update_config`. The assistant is then offered the names `screen_point_at`
 * resolves against before it names one, which are often not the visible
 * labels. The read starts once the frame is in hand, so it never delays the
 * picture the turn reads, and it is not judged by the gate: an unchanged
 * screen sends nothing because an unchanged snapshot is not sent again.
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

import { useEffect, useRef, useState } from "react";

import {
  isLiveVoiceSessionActive,
  isLiveVoiceUserSpeaking,
  takeLiveVoiceLookFrame,
  updateLiveVoiceSessionConfig,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { annotateSharedFrame } from "@/domains/chat/voice/live-voice/annotate-shared-frame";
import {
  createSightCapture,
  LOOK_FRAME_REASON,
  type SightKeepOrigin,
} from "@/domains/chat/voice/live-voice/sight-capture";
import { useSupportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
import {
  createFrameGate,
  DEFAULT_FRAME_GATE_OPTIONS,
  type FrameGateOptions,
} from "@/lib/camera/frame-gate";
import { createFrameGridProducer } from "@/lib/camera/frame-sampler";
import { stillFrameGrid } from "@/lib/camera/still-frame-grid";
import { captureError } from "@/lib/sentry/capture-error";
import {
  captureCompanionScreen,
  readCompanionShareTargets,
  reportCompanionSharedFrame,
} from "@/runtime/companion-surface";
import { decodeBase64Payload } from "@/utils/base64";
import type { CompanionAnnotationStroke } from "@vellumai/ipc-contract";

/** Where a failure is filed, so the tag says which source it came from. */
const ERROR_CONTEXT = "live-voice screen share: capture/upload frame";

/** A mark the user finished on the shared surface, and the colour of it. */
type SharedDrawing = {
  strokes: readonly CompanionAnnotationStroke[];
  ink: string;
};

/**
 * The camera's gate with the rules that are about a lens turned off.
 *
 * The novelty bars are the camera's own. What "a view the call already has"
 * and "a question about the view" mean is a property of the picture, not of
 * where it came from, and one set of numbers is one thing to tune.
 *
 * The screen has no exposure to converge, so there is no warmup. Nothing on
 * it is ever moving: the settle check reads two adjacent video frames for a
 * smear, and two stills of a screen taken a beat apart that differ are two
 * views, not one view mid-motion, so the frame of a question asked as a page
 * finishes loading is the page and not a skip. With that off, the settle
 * dwell, which holds a frame until the view has been still for a while,
 * would only ever hold the first one: a screen is still by being a screen.
 * And there is no floor on detail. The floor is for a camera's sensor noise,
 * which a screen capture has none of, and a blank document or an empty
 * terminal is still what the user is showing; refusing it would mean the
 * share never lands and the shell never admits the assistant's marks against
 * it.
 */
export const SCREEN_SHARE_FRAME_GATE_OPTIONS: FrameGateOptions = {
  ...DEFAULT_FRAME_GATE_OPTIONS,
  warmupMs: 0,
  settleThreshold: Number.POSITIVE_INFINITY,
  settleDwellMs: 0,
  minDetail: 0,
};

/** A session that holds no snapshot, serialized the way one is sent. */
const NOTHING_OFFERED = JSON.stringify(null);

export function useLiveVoiceScreenShare(): void {
  const target = useLiveVoiceStore.use.screenShareTarget();
  const state = useLiveVoiceStore.use.state();
  const assistantId = useLiveVoiceStore.use.assistantId();
  const sightFramesUnsupported = useLiveVoiceStore.use.sightFramesUnsupported();
  const controls = useLiveVoiceStore.use.controls();
  const reconnecting = useLiveVoiceStore.use.reconnecting();
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

  // The snapshot of the surface's controls the session was last handed,
  // serialized, so an unchanged surface sends nothing. Held for the mount
  // rather than the run, since the resets that clear it are the session's
  // (connection ready, reconnect) as well as the run's.
  const offered = useRef(NOTHING_OFFERED);

  const connectedShare = active && state !== "connecting" && !reconnecting;
  useEffect(() => {
    if (!connectedShare || controls === null) {
      return;
    }
    controls.updateConfig({ screenSharing: true });
    // A snapshot read before the session could take it never arrived, so the
    // next read is sent whatever it holds.
    offered.current = NOTHING_OFFERED;
    return () => controls.updateConfig({ screenSharing: false });
  }, [connectedShare, controls]);

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
    // Bumped at every boundary a frame in flight must not cross: the stop and
    // a reconnect. A capture reads it back before it is judged, so a picture
    // from before the boundary is never made the gate's idea of what the call
    // is looking at.
    let generation = 0;
    // When the gate was last asked for a frame of the question's view, for
    // the timing a forced keep reports. Null once a keep has answered it.
    let armedAtMs: number | null = null;
    // Occasions are taken one at a time, in the order they came, so the gate
    // judges pictures in the order they were taken: the two edges of a short
    // utterance could otherwise resolve out of order, and the older picture
    // be judged as the newer view.
    let queue: Promise<void> = Promise.resolve();
    // A frame as the gate saw it, when, and in what order. A copy, since the
    // producer reuses its one grid. The order is the judge's, not the
    // clock's: two frames a beat apart can share a millisecond.
    type JudgedFrame = {
      readonly grid: Uint8Array;
      readonly atMs: number;
      readonly seq: number;
    };
    let judgedSeq = 0;
    // The last frame the call was given. What the gate is put back to when a
    // keep fails to arrive; null until something has.
    let delivered: JudgedFrame | null = null;
    // The frame the gate is judging against right now, as this run last set
    // it: the newest keep, or what a failure put back. Null after a reset.
    // Kept here because the gate does not say, and two questions need it:
    // whether a frame that never arrived is still the baseline, and whether
    // a frame that did arrive late is newer than it.
    let baseline: JudgedFrame | null = null;
    // One gate and one downscale chain for the run. A new target is a new run
    // and so a fresh baseline, which is right: the last keep was of another
    // surface and says nothing about this one.
    const gate = createFrameGate(SCREEN_SHARE_FRAME_GATE_OPTIONS);
    gate.reset(performance.now());
    const grids = createFrameGridProducer();
    sight.grantConsent();
    // Reads of the surface's controls, counted as they start, so only the
    // newest may be sent: a slow read must not put an older tree over a
    // newer one.
    let targetReads = 0;

    /**
     * Read what the surface offers to be pointed at and hand it to the
     * session. A surface with nothing to offer sends `null`, which clears
     * whatever the session held.
     */
    const offerTargets = (run: number): void => {
      targetReads += 1;
      const read = targetReads;
      void readCompanionShareTargets(target).then((snapshot) => {
        if (cancelled || generation !== run || read !== targetReads) {
          return;
        }
        const next =
          snapshot === null || snapshot.targets.length === 0 ? null : snapshot;
        const serialized = JSON.stringify(next);
        if (serialized === offered.current) {
          return;
        }
        offered.current = serialized;
        updateLiveVoiceSessionConfig({ shareTargets: next });
      });
    };

    /**
     * Not filed: a window that closed or a permission not granted is the
     * desktop's answer, not a fault. Lowering the ask is what tells the
     * control, and this effect's own cleanup ends the run. A missing grant
     * is told to the user by main, which sends them to it when it sees the
     * helper refuse the frame.
     */
    const lowerShare = (): void => {
      console.warn(
        "[live-voice screen share] no frame of the shared target; stopping the share",
      );
      useLiveVoiceStore.getState().setScreenShareTarget(null);
    };

    /**
     * Make `frame` what the gate judges against, or nothing when there is
     * no frame to give it. Both ways drop a standing arm, so the question
     * still open gets its ask again.
     */
    const moveGateTo = (frame: JudgedFrame | null): void => {
      if (frame === null) {
        gate.reset(performance.now());
      } else {
        gate.adopt(frame.grid, frame.atMs);
      }
      baseline = frame;
      if (armedAtMs !== null) {
        gate.armForcedKeep(armedAtMs);
      }
    };

    /**
     * A frame the call was given.
     *
     * Usually the gate is already judging against it, since a keep moves
     * the baseline when it is judged. Not always: a send waits its turn
     * behind older captures, and a newer frame that was lost in the
     * meantime put the gate back to something older than this. Then this
     * is the newest view the call has, and the gate is brought up to it.
     */
    const arrived = (frame: JudgedFrame): void => {
      delivered = frame;
      if (baseline === null || baseline.seq < frame.seq) {
        moveGateTo(frame);
      }
    };

    /**
     * A frame the call will never be given.
     *
     * A keep moves the gate's baseline when it is judged, and the upload
     * behind it can still fail. Left as it was, the gate would judge every
     * later frame against a view the call never saw: the same screen turned
     * away as `unchanged`, a question about it as `answered`, and the call
     * without a picture until the heartbeat. So the gate goes back to the
     * last frame that did arrive, but only while the lost frame is still
     * what it judges against: a newer keep since has already replaced it,
     * and going back would replace that one too.
     */
    const lost = (frame: JudgedFrame): void => {
      if (baseline !== frame) {
        return;
      }
      moveGateTo(delivered);
    };

    /**
     * Take one frame, judge it, and send it if it is worth sending.
     *
     * `drawing` is what the user drew on the surface, and is null for every
     * frame the cadence takes on its own. A drawing is not judged: it is the
     * one frame here the user asked for by hand, and they have just watched
     * themselves make it. The gate is told about it instead, so the next
     * frame the cadence takes is judged against the view the call was given
     * rather than against the keep before it.
     *
     * `run` is the generation the occasion was queued under. An occasion
     * queued behind a slow capture is asked for again here before it asks
     * the helper, since the share it was queued for may have stopped or
     * moved in the meantime: a frame of a surface the user has stopped
     * showing is not taken, even to be thrown away.
     *
     * `askedAtMs` is when the question this occasion opens started, for the
     * start of one, and null for every other occasion. The gate is armed
     * with it here, in queue order and just before this occasion's own
     * picture is judged, so a later question's ask cannot overwrite this
     * one's while this one's picture still waits its turn.
     *
     * `look` marks the frame the assistant asked for by looking. Like a
     * drawing it is not judged: the session answers the look from this frame
     * and says nothing until it lands, so a view the call already has is
     * still sent. The gate adopts it, so the cadence after it is judged
     * against the view the call was just given.
     *
     * `offer` reads the surface's controls for the session once the frame is
     * in hand ({@link offerTargets}).
     */
    const take = async (
      drawing: SharedDrawing | null,
      run: number,
      askedAtMs: number | null,
      look: boolean,
      offer: boolean,
    ): Promise<void> => {
      const stale = (): boolean => cancelled || generation !== run;
      if (stale()) {
        return;
      }
      // The picture's lower bound. The gate must not spend a question's arm
      // on a picture taken before the question, and the helper's answer time
      // is only an upper bound on when its picture was taken.
      const requestedAtMs = performance.now();
      const frame = await captureCompanionScreen(target);
      if (stale()) {
        return;
      }
      if (frame === null) {
        lowerShare();
        return;
      }
      if (offer) {
        offerTargets(run);
      }
      const bytes = decodeBase64Payload(frame.jpegBase64);
      if (bytes === null) {
        console.warn(
          "[live-voice screen share] the helper's frame is not a picture; skipped",
        );
        return;
      }
      const grid = await stillFrameGrid(bytes, grids);
      if (stale()) {
        return;
      }
      const nowMs = performance.now();
      // What this occasion is about to make the gate's baseline, copied out
      // of the producer's reused grid: on delivery it is what the call has,
      // and until then it is what a failure has to undo.
      judgedSeq += 1;
      const judged: JudgedFrame | null =
        grid === null
          ? null
          : { grid: new Uint8Array(grid), atMs: nowMs, seq: judgedSeq };
      let keep: SightKeepOrigin;
      if (drawing !== null || look) {
        if (grid !== null) {
          gate.adopt(grid, nowMs);
          baseline = judged;
        }
        // A drawing on the frame outranks the look it was taken for: the
        // marks are what the user pointed at, and the session answers a look
        // only from a frame reported as one.
        keep = { reason: drawing !== null ? "drawing" : LOOK_FRAME_REASON };
      } else {
        // A frame the gate cannot read is not sent unjudged: that is the
        // second frame of one view this file exists to stop, and a share
        // that visibly sends nothing is the honest shape of a broken decode.
        if (grid === null) {
          console.warn(
            "[live-voice screen share] frame could not be judged; skipped",
          );
          return;
        }
        if (askedAtMs !== null) {
          // The ask stands from when the question started: the picture was
          // asked for after that, so it can spend the ask.
          armedAtMs = askedAtMs;
          gate.armForcedKeep(askedAtMs);
        }
        const decision = gate.offer(grid, nowMs, requestedAtMs);
        if (!decision.keep) {
          console.debug("[live-voice screen share] frame skipped:", {
            reason: decision.reason,
            novelty: decision.novelty,
          });
          return;
        }
        keep =
          decision.reason === "forced" && armedAtMs !== null
            ? { reason: decision.reason, armedAtMs }
            : { reason: decision.reason };
        if (decision.reason === "forced") {
          armedAtMs = null;
        }
        baseline = judged;
      }
      // Not awaited: the queue orders the pictures, and the upload behind
      // each keep is ordered by the capture itself, so the next occasion need
      // not wait for this one to reach the daemon.
      void sight.capture({
        assistantId,
        keep,
        produceFrame: async (filename) => {
          const file = new File([bytes], filename, { type: "image/jpeg" });
          // The marks are drawn here rather than being on the screen
          // already: a capture excludes Vellum's own windows, so the overlay
          // the user drew on is never in the pixels. See
          // `annotate-shared-frame.ts`.
          return drawing === null
            ? file
            : annotateSharedFrame(file, drawing.strokes, drawing.ink);
        },
        // Nothing to show: there is no viewfinder to put a pulse on. The
        // transcript is where a frame is seen. What this does say is that
        // the call has now been shown this surface, which is what lets the
        // shell admit the assistant's own marks against it. Said here
        // rather than at the capture because only this edge means the frame
        // arrived: everything before it can still fail or be voided.
        onShared: () => {
          if (judged !== null && !stale()) {
            arrived(judged);
          }
          reportCompanionSharedFrame(target);
        },
        // A run that has since ended has nothing to put back, and a drawing
        // the gate could not read never moved it.
        onDropped: () => {
          if (judged !== null && !stale()) {
            lost(judged);
          }
        },
      });
    };

    const share = (
      drawing: SharedDrawing | null = null,
      askedAtMs: number | null = null,
      look = false,
      offer = false,
    ): void => {
      // Stamped now rather than when the occasion is dequeued, so a stop or
      // a reconnect that lands while it waits is one it cannot outlive.
      const run = generation;
      queue = queue
        .then(() => take(drawing, run, askedAtMs, look, offer))
        .catch((err: unknown) => {
          // One occasion, filed. The queue goes on, so a decode that threw
          // cannot hold every later frame behind it.
          captureError(err, { context: ERROR_CONTEXT, bestEffort: true });
        });
    };

    // A share a look started owes that look its first frame.
    share(null, null, takeLiveVoiceLookFrame("screen"), true);
    let speaking = isLiveVoiceUserSpeaking(useLiveVoiceStore.getState());
    let reconnecting = useLiveVoiceStore.getState().reconnecting;
    // The drawing this run has already sent. A run that starts with one
    // already in the store inherits it as sent rather than as new: the marks
    // it names are long since faded off the shared surface, and a frame taken
    // for them now would be of a screen with nothing on it.
    let annotation = useLiveVoiceStore.getState().shareAnnotation?.id ?? 0;
    const unsubscribe = useLiveVoiceStore.subscribe((session) => {
      // **The stop is honoured here, not in the cleanup below.** A store
      // subscriber runs inside the `set` that ends the share; the cleanup is
      // a passive effect and runs a render later. An upload resolving in
      // that gap would still read the epoch it was captured under and send a
      // frame of what the user has just stopped showing.
      if (session.screenShareTarget !== target) {
        // A stop tells the session the share is off, which clears what it
        // held. A move to another surface is cleared here, so a turn taken
        // before the next run's read lands is not offered this surface's
        // names to point at on that one.
        if (
          session.screenShareTarget !== null &&
          offered.current !== NOTHING_OFFERED
        ) {
          updateLiveVoiceSessionConfig({ shareTargets: null });
        }
        offered.current = NOTHING_OFFERED;
        generation += 1;
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
          generation += 1;
          sight.invalidate();
          // A frame voided here never reached the transcript, so the gate
          // must not go on believing the call has it: the next occasion
          // keeps whatever is on screen afresh. That can repeat a view a
          // frame from before the drop did land, once per reconnect, which
          // is the cheaper mistake.
          gate.reset(performance.now());
          delivered = null;
          baseline = null;
          armedAtMs = null;
          // The session on the far side of the drop holds no snapshot.
          offered.current = NOTHING_OFFERED;
        }
        return;
      }
      // **A finished drawing goes at once**, ahead of every gate below it,
      // because it is the one frame here the user asked for by hand. The
      // cadence sends what the session might want to see; this sends what
      // they pointed at, and it goes on the release rather than on the next
      // thing they say.
      const drawn = session.shareAnnotation;
      if (drawn !== undefined && drawn !== null && drawn.id !== annotation) {
        annotation = drawn.id;
        share({ strokes: drawn.strokes, ink: drawn.ink });
        return;
      }
      // **A look goes at once too**, for the same reason: the assistant asked
      // to see the screen as it is now, and it says nothing until this frame
      // lands. Taken before anything below can return, so the ask is never
      // left owed on a share that is running.
      if (
        session.lookFrameRequested.screen &&
        takeLiveVoiceLookFrame("screen")
      ) {
        share(null, null, true, true);
        return;
      }
      // The hand is still down. Whatever moved, it is not worth a frame: the
      // mark is half made, and the user is usually talking while they make
      // it, which is exactly what the cadence below would take a frame for.
      if (session.shareDrawing) {
        speaking = isLiveVoiceUserSpeaking(session);
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
      // The question is starting, and the frame the turn reads is the one
      // taken now, at the bar a question earns. The ask travels with the
      // occasion rather than going to the gate here: the picture is judged
      // in its turn, and an ask placed now would be the gate's by the time
      // an earlier picture is judged.
      share(null, next ? performance.now() : null, false, next);
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
