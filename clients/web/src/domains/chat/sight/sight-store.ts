/**
 * sight-store - the camera behind the composer's Eyes toggle.
 *
 * Owns one webcam capture for the desktop chat: the `MediaStream` the floating
 * tile previews, the sampler that feeds the shared frame gate
 * (`lib/camera/frame-gate.ts`), and the single frame the gate last judged worth
 * keeping. A send reads that frame and attaches it, so the assistant answers
 * about what the camera can see.
 *
 * ## Video only, always
 *
 * `getUserMedia` is asked for `{ video: ... }` and nothing else. A live-voice
 * session holds its own microphone stream, and on iOS that stream sits on an
 * `AVAudioSession` configured for the call; an `{ audio, video }` request hands
 * back a second, differently configured audio track and tears that capture
 * graph down. Same rule, and the same reason, as
 * `voice/voice-room/voice-camera.ts`.
 *
 * ## Why only one frame is held
 *
 * The gate already answers "is this worth sending", so keeping a buffer of
 * candidates would only make the send pick between frames it has no way to rank.
 * The newest keep replaces the previous one, and a send takes whatever is in
 * hand.
 *
 * ## What releases the camera
 *
 * The toggle, the tile's close button, the tile leaving the tree, the app going
 * to the background, and a live voice session starting. The background one is
 * the consent story: a camera light that stays on behind a hidden window is one
 * the user did not agree to. The signal arrives as the bus's `app.hidden`,
 * which is published from the app's one `visibilitychange` listener and from
 * the Capacitor app-state source, rather than from a listener of this store's
 * own (see `docs/EVENT_BUS.md`).
 *
 * The voice session is arbitration rather than consent. The voice room raises
 * its own viewfinder and samples it for the call, and two surfaces cannot hold
 * one webcam: on most machines the second `getUserMedia` simply fails, and
 * where it does not the user is left with two camera previews and no way to
 * tell which one the assistant is reading. The call wins, because it is the one
 * with a live conversation attached to it, and the composer's toggle disables
 * itself for the duration rather than offering a camera it would lose.
 *
 * The camera can also be taken rather than given up: a revoked permission or an
 * unplugged webcam ends the tracks. That lands in an error rather than off, so
 * the tile says what happened instead of disappearing, and the frame it was
 * holding goes with it.
 */

import { create } from "zustand";

import {
  isLiveVoiceSessionActive,
  subscribeSettledLiveVoiceState,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { captureVideoFrame } from "@/domains/chat/voice/voice-room/voice-camera";
import {
  DEFAULT_FRAME_GATE_OPTIONS,
  createFrameGate,
} from "@/lib/camera/frame-gate";
import {
  createFrameSampler,
  type FrameSampler,
} from "@/lib/camera/frame-sampler";
import { subscribe } from "@/lib/event-bus";
import { createSelectors } from "@/utils/create-selectors";

/** Where the camera is in its lifecycle. */
export type SightStatus = "off" | "starting" | "on" | "error";

/**
 * Why the camera is not running. All but the last are mapped from
 * `getUserMedia` DOMExceptions; `interrupted` is a capture that opened and was
 * then taken away from outside the app.
 */
export type SightError =
  | "unsupported"
  | "permission-denied"
  | "no-device"
  | "device-in-use"
  | "interrupted"
  | "unknown";

/** The most recent frame the gate kept, and when it was encoded. */
export interface SightKeptFrame {
  file: File;
  atMs: number;
}

export interface SightState {
  status: SightStatus;
  stream: MediaStream | null;
  /** The frame a send would attach, or null while nothing has been kept. */
  latestKeep: SightKeptFrame | null;
  /**
   * Why the camera is not running: a {@link SightActions.start} that failed, or
   * a capture the browser ended underneath us. Cleared by the next start.
   */
  error: SightError | null;
}

export interface SightActions {
  /**
   * Request the camera and raise the viewfinder. Call directly from the click,
   * so the tap that opens the camera is what raises the OS permission alert.
   */
  start: () => Promise<void>;
  /** Release the camera and everything hanging off it. Idempotent. */
  stop: () => void;
  /**
   * Register the tile's playing `<video>` as the sampling source, or `null` on
   * unmount. Starting the sampler needs an element with frames in it, which is
   * why the tile calls this rather than `start`.
   */
  attachPreviewVideo: (video: HTMLVideoElement | null) => void;
  /**
   * The frame this send should carry, or null when the camera is off.
   *
   * Prefers the gate's last keep. A camera opened a moment ago has none (the
   * gate holds frames back through the exposure warmup), and the live frame
   * beats sending nothing.
   */
  takeSendFrame: () => Promise<File | null>;
}

export type SightStore = SightState & SightActions;

// Ideals keep a low-resolution webcam usable while asking a capable one for
// enough detail to be worth reading. Matches the voice room's viewfinder.
const IDEAL_WIDTH = 1920;
const IDEAL_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Internal mutable state (not reactive - never triggers re-renders)
// ---------------------------------------------------------------------------

/** The running sampler, or null when nothing is being sampled. */
let sampler: FrameSampler | null = null;
/** The element the sampler is reading, so a late capture can tell it is stale. */
let previewVideo: HTMLVideoElement | null = null;
/** Bus handle for the background release, held for as long as the camera is. */
let unsubscribeAppHidden: (() => void) | null = null;
/** Store handle for the voice-session release, held the same way. */
let unsubscribeVoiceSession: (() => void) | null = null;
/**
 * Takes the `ended` listeners back off the running capture's tracks. Held as
 * the detach rather than the tracks so every teardown path drops them the same
 * way, and a released stream can never fire into the session that replaced it.
 */
let detachTrackEnded: (() => void) | null = null;
/**
 * Bumped by every start and every stop, so a `getUserMedia` that resolves after
 * it was superseded can tell and release its own stream. Without it the
 * hardware stays live with nothing holding it, which is a camera light that
 * never goes out.
 */
let acquireEpoch = 0;
/** Numbers the captured frames, so a transcript reads "sight-2" for the second. */
let captureCount = 0;

function classifyStartError(cause: unknown): SightError {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "permission-denied";
      case "NotFoundError":
      case "OverconstrainedError":
        return "no-device";
      case "NotReadableError":
        return "device-in-use";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

function nextCaptureFilename(): string {
  captureCount += 1;
  return `sight-${captureCount}.jpg`;
}

const useSightStoreBase = create<SightStore>()((set, get) => {
  /**
   * Give the hardware back and drop everything hanging off it, saying nothing
   * about the state that leaves behind. Two callers want different answers: a
   * stop lands off, an interruption lands in an error the tile has to explain.
   * Bumping the acquire epoch belongs to the caller for the same reason.
   */
  function releaseCapture(): void {
    if (unsubscribeAppHidden) {
      unsubscribeAppHidden();
      unsubscribeAppHidden = null;
    }
    if (unsubscribeVoiceSession) {
      unsubscribeVoiceSession();
      unsubscribeVoiceSession = null;
    }
    if (detachTrackEnded) {
      detachTrackEnded();
      detachTrackEnded = null;
    }
    if (sampler) {
      sampler.stop();
      sampler = null;
    }
    previewVideo = null;
    const stream = get().stream;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }

  /**
   * Notice a capture ending from outside the app: a revoked permission, a
   * webcam unplugged, another application taking the device.
   *
   * Nothing else would. The preview would sit frozen on its last decoded frame
   * and every later send would attach the same stale JPEG, which is worse than
   * no camera at all because it looks like one that works. Landing in an error
   * rather than plain off is what lets the tile say so instead of vanishing.
   *
   * `stop()` on a track does not fire `ended` (the spec says so), so this
   * cannot hear the store's own teardown. The epoch is checked anyway: a
   * listener that somehow outlives its session must not speak for the one that
   * replaced it.
   */
  function watchForInterruption(stream: MediaStream, epoch: number): void {
    const tracks = stream.getVideoTracks();
    const onEnded = () => {
      if (epoch !== acquireEpoch) {
        return;
      }
      acquireEpoch++;
      releaseCapture();
      set({
        status: "error",
        stream: null,
        // The frozen frame goes with the camera. `takeSendFrame` refuses off an
        // "on" status anyway, but a kept frame nobody can refresh is not a
        // frame this store should still be holding.
        latestKeep: null,
        error: "interrupted",
      });
    };
    for (const track of tracks) {
      track.addEventListener("ended", onEnded);
    }
    detachTrackEnded = () => {
      for (const track of tracks) {
        track.removeEventListener("ended", onEnded);
      }
    };
  }

  return {
    status: "off",
    stream: null,
    latestKeep: null,
    error: null,

    start: async () => {
      const status = get().status;
      if (status === "starting" || status === "on") {
        return;
      }
      const epoch = ++acquireEpoch;
      set({ status: "starting", error: null });

      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        set({ status: "error", error: "unsupported" });
        return;
      }

      let stream: MediaStream;
      try {
        // Video only. See the module docstring: an `audio` key here renegotiates
        // the microphone a live-voice call is already streaming from.
        //
        // `facingMode` is a plain (non-`exact`) constraint so a laptop with one
        // camera opens it instead of failing with OverconstrainedError.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: IDEAL_WIDTH },
            height: { ideal: IDEAL_HEIGHT },
          },
        });
      } catch (cause) {
        // A rejection that lands after a stop is not news the user needs: the
        // stop already set the state it wanted.
        if (epoch !== acquireEpoch) {
          return;
        }
        set({
          status: "error",
          stream: null,
          error: classifyStartError(cause),
        });
        return;
      }

      if (epoch !== acquireEpoch) {
        // Superseded while the request was in flight, so this stream belongs to
        // nobody: the stop that cancelled it ran against an empty slot.
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }

      // Attached only on the path that actually holds hardware, and dropped by
      // the stop that gives it back.
      unsubscribeAppHidden = subscribe("app.hidden", () => {
        get().stop();
      });
      // Settled rather than raw: starting a session writes `idle` and four
      // half-built frames before it settles, and a raw subscriber would give
      // the camera back to a session that never existed.
      unsubscribeVoiceSession = subscribeSettledLiveVoiceState((session) => {
        if (isLiveVoiceSessionActive(session.state)) {
          get().stop();
        }
      });
      set({ status: "on", stream, error: null });
      // Ahead of the visibility check below, so a camera that goes straight back
      // has its listeners taken off by that stop rather than left on a released
      // stream.
      watchForInterruption(stream, epoch);
      // Both subscriptions begin after the permission round trip, so anything
      // that happened during it was published before anyone listened. Read the
      // state they left behind: a camera raised behind a hidden window, or into
      // a call that started while the permission alert was up, goes straight
      // back.
      if (
        document.visibilityState === "hidden" ||
        isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)
      ) {
        get().stop();
      }
    },

    stop: () => {
      acquireEpoch++;
      releaseCapture();
      set({ status: "off", stream: null, latestKeep: null, error: null });
    },

    attachPreviewVideo: (video) => {
      if (sampler) {
        sampler.stop();
        sampler = null;
      }
      previewVideo = video;
      if (!video) {
        return;
      }

      const gate = createFrameGate(DEFAULT_FRAME_GATE_OPTIONS);
      gate.reset(performance.now());
      // The capture this decision triggers spans an encode, so both the camera
      // and the element can be replaced under it.
      const epoch = acquireEpoch;
      const next = createFrameSampler({
        gate,
        onDecision: (decision) => {
          if (!decision.keep) {
            return;
          }
          void (async () => {
            const file = await captureVideoFrame(video, nextCaptureFilename());
            if (!file || epoch !== acquireEpoch || previewVideo !== video) {
              return;
            }
            set({ latestKeep: { file, atMs: Date.now() } });
          })();
        },
      });
      sampler = next;
      next.start(video);
    },

    takeSendFrame: async () => {
      if (get().status !== "on") {
        return null;
      }
      const kept = get().latestKeep;
      if (kept) {
        return kept.file;
      }
      const video = previewVideo;
      if (!video) {
        return null;
      }
      return captureVideoFrame(video, nextCaptureFilename());
    },
  };
});

export const useSightStore = createSelectors(useSightStoreBase);
