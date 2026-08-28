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
 * The toggle, the tile's close button, and the app going to the background. The
 * last one is the consent story: a camera light that stays on behind a hidden
 * window is one the user did not agree to. That signal arrives as the bus's
 * `app.hidden`, which is published from the app's one `visibilitychange`
 * listener and from the Capacitor app-state source, rather than from a listener
 * of this store's own (see `docs/EVENT_BUS.md`).
 */

import { create } from "zustand";

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

/** Why the camera failed to open, mapped from `getUserMedia` DOMExceptions. */
export type SightError =
  | "unsupported"
  | "permission-denied"
  | "no-device"
  | "device-in-use"
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
  /** Why the last {@link SightActions.start} failed. Cleared by the next one. */
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

const useSightStoreBase = create<SightStore>()((set, get) => ({
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
      set({ status: "error", stream: null, error: classifyStartError(cause) });
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
    set({ status: "on", stream, error: null });
    // The subscription begins after the permission round trip, so a hide
    // during that round trip was published before anyone listened. Read the
    // state it left behind: a camera raised behind a hidden window goes
    // straight back.
    if (document.visibilityState === "hidden") {
      get().stop();
    }
  },

  stop: () => {
    acquireEpoch++;
    if (unsubscribeAppHidden) {
      unsubscribeAppHidden();
      unsubscribeAppHidden = null;
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
}));

export const useSightStore = createSelectors(useSightStoreBase);
