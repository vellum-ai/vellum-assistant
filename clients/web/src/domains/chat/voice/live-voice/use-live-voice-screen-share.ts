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
 * put back, and a picture turned away for it is judged again, so the view
 * it was of is not turned away as one the call has.
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
import { annotateSharedFrame } from "@/domains/chat/voice/live-voice/annotate-shared-frame";
import {
  createSightCapture,
  type SightKeepOrigin,
} from "@/domains/chat/voice/live-voice/sight-capture";
import { useSupportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
import {
  createFrameGate,
  DEFAULT_FRAME_GATE_OPTIONS,
  type FrameGateOptions,
} from "@/lib/camera/frame-gate";
import { createFrameGridProducer, type Tint } from "@/lib/camera/frame-sampler";
import { stillFrameGrid } from "@/lib/camera/still-frame-grid";
import { captureError } from "@/lib/sentry/capture-error";
import {
  captureCompanionScreen,
  reportCompanionSharedFrame,
} from "@/runtime/companion-surface";
import { decodeBase64Payload } from "@/utils/base64";
import type {
  CompanionAnnotationStroke,
  ScreenCaptureFrame,
} from "@vellumai/ipc-contract";

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

/**
 * How long a kept frame may stay neither delivered nor dropped before the
 * share takes it for lost.
 *
 * A keep is the gate's baseline from the moment it is judged, and the
 * pictures behind it are judged against it, so its fate has to be known
 * within a bound: the upload has none of its own, and one that hangs would
 * otherwise turn every later picture of the same view away for the rest of
 * the call, and hold every later send behind it. An upload of one screen
 * frame takes well under a second. Past this, `sight-capture.ts` writes the
 * frame off: it is reported dropped, the gate goes back to what the call
 * has, the picture turned away for it is judged again, and the sends behind
 * it go on.
 */
export const SCREEN_SHARE_SETTLE_WITHIN_MS = 5_000;

/**
 * How long an occasion waits for the helper's picture before going without.
 *
 * The helper answers in a fraction of a second, and its own client gives up
 * on a call only after the better part of a minute. Pictures are judged one
 * at a time, so one stalled answer would hold every later occasion's
 * picture, already in hand, back from being judged and sent for that long.
 * Past this the occasion is skipped, and the answer, if it ever comes, is
 * not read: its moment has passed, and what it says about the surface is
 * the next occasion's to find out.
 */
export const SCREEN_SHARE_PICTURE_WAIT_MS = 3_000;

/**
 * Below this much structure a screen is flat, and flat screens are compared
 * by their colour rather than by their shape.
 *
 * The gate reads luma alone and normalizes every grid before comparing,
 * which is what makes it blind to a camera's exposure and is exactly wrong
 * for a blank page: a blank light page and a blank dark page normalize to
 * the same nothing, and a red page and a green page of one brightness were
 * the same before that, so the gate reads no change where the user sees a
 * whole new view. The camera refuses such frames outright; a screen keeps
 * them (see {@link SCREEN_SHARE_FRAME_GATE_OPTIONS}), so it has to tell
 * them apart some other way, and what is left to compare is their mean
 * colour. The floor is the camera's own featureless floor, and the shift,
 * on any one channel, is well past anything a screen's own rendering drifts
 * by.
 */
export const SCREEN_SHARE_FLAT_DETAIL = DEFAULT_FRAME_GATE_OPTIONS.minDetail;
export const SCREEN_SHARE_FLAT_TINT_SHIFT = 32;

/** The largest difference between two tints on any one channel. */
function tintShift(a: Tint, b: Tint): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
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
    // Bumped at every boundary a frame in flight must not cross: the stop and
    // a reconnect. A capture reads it back before it is judged, so a picture
    // from before the boundary is never made the gate's idea of what the call
    // is looking at.
    let generation = 0;
    // When the gate was last asked for a frame of the question's view, for
    // the timing a forced keep reports. Null once a keep has answered it.
    let armedAtMs: number | null = null;
    // Occasions are judged one at a time, in the order they came, so the
    // gate sees pictures in the order they were taken: the two edges of a
    // short utterance could otherwise resolve out of order, and the older
    // picture be judged as the newer view. The picture itself is taken the
    // moment the occasion comes, ahead of the queue, and nothing in the
    // queue waits on an upload: the start of a question is the frame the
    // turn reads, and the daemon snapshots the turn when the utterance
    // closes, so neither the picture nor its send can wait on an earlier
    // frame's fate. What a fate still undecided costs is handled by keeping
    // the picture that lost to it; see `skipped`.
    let queue: Promise<void> = Promise.resolve();
    // A frame as the gate saw it, when, and in what order. A copy, since the
    // producer reuses its one grid. The order is the judge's, not the
    // clock's: two frames a beat apart can share a millisecond.
    type JudgedFrame = {
      readonly grid: Uint8Array;
      readonly atMs: number;
      readonly seq: number;
      /** Structure and colour, for telling two flat screens apart. */
      readonly detail: number;
      readonly tint: Tint;
      /**
       * The ask this frame answered, when it was a forced keep: the arm it
       * spent, to be given back if the frame is lost. The ask still stands
       * only inside its own window; the gate drops one that has run out.
       */
      readonly spentArmMs: number | null;
    };
    let judgedSeq = 0;
    // A picture in hand: the helper's bytes, the grid the gate reads, when
    // it was asked for (its lower bound; see `take`), and the generation it
    // was taken under.
    type Picture = {
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly grid: Uint8Array;
      readonly tint: Tint;
      readonly requestedAtMs: number;
      readonly run: number;
    };
    // The last frame the call was given. What the gate is put back to when a
    // keep fails to arrive; null until something has.
    let delivered: JudgedFrame | null = null;
    // The newest picture the gate turned away, and the keep it was judged
    // against, kept until that keep's fate is known. A keep moves the
    // baseline when it is judged, ahead of its upload, so a picture judged
    // against it was judged against a view the call may never get; if the
    // keep is lost, this picture is judged again against what the call
    // does have. Only the newest, since the newest is the view the call
    // would want, and dropped once the keep arrives, since the judgement
    // was right, or once a newer keep supersedes both.
    let skipped: {
      readonly picture: Picture;
      readonly against: number;
    } | null = null;
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

    /**
     * Not filed: a window that closed or a permission not granted is the
     * desktop's answer, not a fault. Lowering the ask is what tells the
     * control, and this effect's own cleanup ends the run.
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
      if (delivered === null || delivered.seq < frame.seq) {
        delivered = frame;
      }
      if (baseline === null || baseline.seq < frame.seq) {
        moveGateTo(frame);
      }
      // The picture turned away for this frame was rightly turned away.
      if (skipped !== null && skipped.against === frame.seq) {
        skipped = null;
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
      // The question this frame was for is still unanswered, so the ask
      // goes back with the gate, unless a newer question has since been
      // asked.
      if (frame.spentArmMs !== null && armedAtMs === null) {
        armedAtMs = frame.spentArmMs;
      }
      moveGateTo(delivered);
      // The picture turned away for this frame is judged again, against
      // what the call has. It is the newest picture there is, since a newer
      // keep would have moved the baseline off this frame.
      if (skipped !== null && skipped.against === frame.seq) {
        const again = skipped.picture;
        skipped = null;
        judge(again, null, null);
      }
    };

    /**
     * Judge one picture, and send it if it is worth sending.
     *
     * `drawing` is what the user drew on the surface, and is null for every
     * frame the cadence takes on its own. A drawing is not judged: it is the
     * one frame here the user asked for by hand, and they have just watched
     * themselves make it. The gate is told about it instead, so the next
     * frame the cadence takes is judged against the view the call was given
     * rather than against the keep before it.
     *
     * `askedAtMs` is when the question this occasion opens started, for the
     * start of one, and null for every other occasion; the gate is armed
     * with it here, in queue order, so a later question's ask cannot
     * overwrite this one's before this one's picture is judged.
     *
     * Nothing here waits: the send goes out the moment the gate says yes,
     * and what it costs the pictures behind it if it never arrives is paid
     * back by `lost`.
     */
    const judge = (
      picture: Picture,
      drawing: SharedDrawing | null,
      askedAtMs: number | null,
    ): void => {
      const { bytes, grid, tint, requestedAtMs, run } = picture;
      const stale = (): boolean => cancelled || generation !== run;
      const nowMs = performance.now();
      judgedSeq += 1;
      let spentArmMs: number | null = null;
      // A drawing is not judged, so its structure is not measured; it is
      // never mistaken for a flat screen.
      let detail = Number.POSITIVE_INFINITY;
      let keep: SightKeepOrigin;
      if (drawing !== null) {
        keep = { reason: "drawing" };
      } else {
        if (askedAtMs !== null) {
          // The ask is placed just before its own picture is judged, and
          // stands from when the question started: the picture was asked
          // for at the same moment, so it can spend the ask, and the ask
          // runs out on the question's clock rather than the queue's.
          armedAtMs = askedAtMs;
          gate.armForcedKeep(askedAtMs);
        }
        const decision = gate.offer(grid, nowMs, requestedAtMs);
        // A flat screen whose colour changed is a new view the gate cannot
        // see; see `SCREEN_SHARE_FLAT_DETAIL`. Adopted, so the gate's
        // history is what it would be for a keep, and taken as the answer
        // to an open question, since the ask stands for a change and this
        // is one.
        const flatChange =
          !decision.keep &&
          baseline !== null &&
          (decision.detail < SCREEN_SHARE_FLAT_DETAIL ||
            baseline.detail < SCREEN_SHARE_FLAT_DETAIL) &&
          tintShift(tint, baseline.tint) >= SCREEN_SHARE_FLAT_TINT_SHIFT;
        if (!decision.keep && !flatChange) {
          console.debug("[live-voice screen share] frame skipped:", {
            reason: decision.reason,
            novelty: decision.novelty,
          });
          // Kept only while the keep it lost to is still on its way: one
          // the call has already is a judgement that stands.
          skipped =
            baseline !== null && baseline !== delivered
              ? { picture, against: baseline.seq }
              : null;
          return;
        }
        let reason: string = decision.reason;
        if (flatChange) {
          gate.adopt(grid, nowMs);
          reason = armedAtMs !== null ? "forced" : "novel";
        }
        keep =
          reason === "forced" && armedAtMs !== null
            ? { reason, armedAtMs }
            : { reason };
        if (reason === "forced") {
          spentArmMs = armedAtMs;
          armedAtMs = null;
        }
        detail = decision.detail;
      }
      // What this occasion has just made the gate's baseline: on delivery
      // it is what the call has, and until then it is what a failure has to
      // undo. A newer keep supersedes whatever was turned away before it.
      const judged: JudgedFrame = {
        grid: picture.grid,
        atMs: nowMs,
        seq: judgedSeq,
        detail,
        tint,
        spentArmMs,
      };
      if (drawing !== null) {
        gate.adopt(judged.grid, nowMs);
      }
      baseline = judged;
      skipped = null;
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
          if (!stale()) {
            arrived(judged);
          }
          reportCompanionSharedFrame(target);
        },
        // A run that has since ended has nothing to put back.
        onDropped: () => {
          if (!stale()) {
            lost(judged);
          }
        },
        settleWithinMs: SCREEN_SHARE_SETTLE_WITHIN_MS,
      });
    };

    /**
     * Take one occasion's picture in hand and judge it.
     *
     * `picture` is the helper's answer for the occasion, asked for when the
     * occasion came, and `requestedAtMs` is when: the picture's lower bound,
     * since the gate must not spend a question's arm on a picture taken
     * before the question, and the helper's answer time is only an upper
     * bound on when its picture was taken. `run` is the generation the
     * occasion was queued under, read again here since the share it was
     * queued for may have stopped or moved while it waited.
     */
    const take = async (
      drawing: SharedDrawing | null,
      run: number,
      picture: Promise<ScreenCaptureFrame | null>,
      requestedAtMs: number,
      askedAtMs: number | null,
    ): Promise<void> => {
      const stale = (): boolean => cancelled || generation !== run;
      if (stale()) {
        return;
      }
      // The bound runs from when the picture was asked for, not from when
      // its turn came: time spent queued behind a stalled answer is time
      // this answer has already had, and a picture already in hand wins
      // the race whatever is left.
      const remainingMs = Math.max(
        0,
        SCREEN_SHARE_PICTURE_WAIT_MS - (performance.now() - requestedAtMs),
      );
      let timer: ReturnType<typeof setTimeout> | null = null;
      const frame = await Promise.race([
        picture,
        new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), remainingMs);
        }),
      ]);
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (stale()) {
        return;
      }
      if (frame === "late") {
        console.warn(
          "[live-voice screen share] no picture from the helper in time; skipped",
        );
        return;
      }
      if (frame === null) {
        lowerShare();
        return;
      }
      const bytes = decodeBase64Payload(frame.jpegBase64);
      if (bytes === null) {
        console.warn(
          "[live-voice screen share] the helper's frame is not a picture; skipped",
        );
        return;
      }
      const still = await stillFrameGrid(bytes, grids);
      if (stale()) {
        return;
      }
      // A drawing the gate cannot read still goes, since the user asked for
      // it by hand, but the gate is left where it is. A cadence frame the
      // gate cannot read is not sent unjudged: that is the second frame of
      // one view this file exists to stop, and a share that visibly sends
      // nothing is the honest shape of a broken decode.
      if (still === null) {
        if (drawing === null) {
          console.warn(
            "[live-voice screen share] frame could not be judged; skipped",
          );
          return;
        }
        void sight.capture({
          assistantId,
          keep: { reason: "drawing" },
          produceFrame: async (filename) =>
            annotateSharedFrame(
              new File([bytes], filename, { type: "image/jpeg" }),
              drawing.strokes,
              drawing.ink,
            ),
          onShared: () => reportCompanionSharedFrame(target),
        });
        return;
      }
      // Copied out of the producer's reused grid, which the next picture
      // draws over.
      judge(
        {
          bytes,
          grid: new Uint8Array(still.grid),
          tint: still.tint,
          requestedAtMs,
          run,
        },
        drawing,
        askedAtMs,
      );
    };

    const share = (
      drawing: SharedDrawing | null = null,
      askedAtMs: number | null = null,
    ): void => {
      // Stamped now rather than when the occasion is dequeued, so a stop or
      // a reconnect that lands while it waits is one it cannot outlive.
      const run = generation;
      // Taken now, of the screen as it is at this moment, whatever the queue
      // is still waiting on. The helper's own failure is its answer, read
      // when the picture is judged.
      const requestedAtMs = performance.now();
      const picture = captureCompanionScreen(target);
      queue = queue
        .then(() => take(drawing, run, picture, requestedAtMs, askedAtMs))
        .catch((err: unknown) => {
          // One occasion, filed. The queue goes on, so a decode that threw
          // cannot hold every later frame behind it.
          captureError(err, { context: ERROR_CONTEXT, bestEffort: true });
        });
    };

    share();
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
      share(null, next ? performance.now() : null);
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
