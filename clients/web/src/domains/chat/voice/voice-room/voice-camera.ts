/**
 * The app's camera acquisition: a live viewfinder, and a shutter that turns the
 * current frame into a `File`.
 *
 * Two surfaces run on it. The voice room leaves a viewfinder open for the whole
 * call, and the composer's `deeplink.openCamera` capture
 * (`chat-attachments/camera-capture-overlay.tsx`) raises one for a single
 * photo, where the system camera is unreachable for a second reason: that
 * request arrives from outside the web view and carries no DOM user activation.
 *
 * ## Why this is not the system camera UI
 *
 * On iOS the obvious move (`<input type="file" capture="environment">`, which
 * raises Apple's own camera) is wrong for this feature in three ways: it is
 * modal and one-shot, so every photo costs a full open/aim/expose cycle; it
 * covers the room, so the call it belongs to disappears while you use it; and
 * it puts the OS in charge of an audio session that a call is currently
 * holding. The room therefore owns a persistent preview: a native Capacitor
 * camera layer on mobile and a `<video>` stream as the browser fallback.
 *
 * ## The one hard rule: never renegotiate the call's audio
 *
 * The live-voice session already holds a microphone stream (`pcm-capture.ts`),
 * and on iOS that stream sits on an `AVAudioSession` in `.voiceChat` mode with
 * hardware echo cancellation attached to it. This module therefore requests
 * `{ video: … }` and NOTHING else. Asking for `{ audio: true, video: true }`
 * would hand back a second, differently-configured audio track and tear down
 * the capture graph the call is running on. The failure mode is a call
 * that goes deaf, or an echo bug of the kind this codebase has already fixed
 * once (see `clients/ios/docs/NATIVE_VOICE.md`).
 *
 * ## Permissions
 *
 * `open()` calls the native camera bridge, or `getUserMedia` on the fallback
 * path, directly so the tap that opens the camera is the thing that raises the
 * OS alert. Nothing dismissible may sit between the two, so the room offers a
 * plain camera button rather than an explanatory sheet.
 *
 * ## Flash: ask first, always, and hand it back
 *
 * Flash is native-only (the web path has no way to fire one) and is governed by
 * three rules the plugin's own implementation forces:
 *
 * 1. **Never touch the flash outside a running preview.** Both flash calls
 *    reach for the capture device the preview owns, so they are made only
 *    between a resolved `start()` and the matching `stop()`.
 * 2. **Never set a mode that was not just probed.** The Android implementation
 *    reads the supported-mode list without a null check, and that list is null
 *    on a camera with no flash unit, so a speculative set throws out of the
 *    bridge. Every camera is probed on arrival, and every flip lands on a
 *    different camera, so every flip re-probes. The control is offered only on
 *    a camera that reported the whole cycle, which is what makes every mode it
 *    can then send one the probe already named.
 * 3. **Leave the plugin as it was found.** The plugin instance is app-global
 *    and shared with the composer's capture overlay
 *    (`chat-attachments/camera-capture-overlay.tsx`), and neither platform
 *    carries a flash mode across a flip, so the mode is cleared before the
 *    camera it was set on goes away, and the user's preference is re-applied to
 *    whatever camera arrives next.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { dataUriToUint8Array } from "@/domains/chat/components/chat-attachments/utils";
import { isNativeMobile } from "@/runtime/platform-detection";
import {
  captureNativeVoiceCameraFrame,
  flipNativeVoiceCamera,
  getNativeVoiceCameraFlashModes,
  setNativeVoiceCameraFlashMode,
  startNativeVoiceCamera,
  stopNativeVoiceCamera,
} from "@/runtime/native-voice-camera";
import { useVoicePrefsStore, type FlashMode } from "@/stores/voice-prefs-store";

/** Which way the camera points. `environment` is the rear/world-facing one. */
export type VoiceCameraFacing = "environment" | "user";

/** Reason the camera failed to open, mapped from `getUserMedia` DOMExceptions. */
export type VoiceCameraError =
  | "unsupported"
  | "permission-denied"
  | "no-device"
  | "device-in-use"
  // The request was superseded or the camera was released while it was in
  // flight. Never shown: whatever superseded it owns the resulting state.
  | "aborted"
  | "unknown";

/**
 * JPEG quality for a captured frame. The attachment pipeline resizes an
 * encoded frame when it exceeds its upload budget, so this value favors a
 * model-readable image without depending on the camera's negotiated size.
 */
const CAPTURE_JPEG_QUALITY = 0.85;

// Ideals keep lower-resolution cameras usable while asking capable devices for
// enough detail to fill a phone-sized viewfinder without visible upscaling.
const VIEWFINDER_IDEAL_WIDTH = 1920;
const VIEWFINDER_IDEAL_HEIGHT = 1080;

/**
 * The modes the control cycles through, and so the modes a camera has to report
 * before the control is offered on it at all.
 *
 * The whole set rather than any of it, for two reasons. A camera that reported
 * only part of the cycle could not honor the cycle, and requiring all three is
 * what makes every `setFlashMode` this module sends a mode the probe just
 * reported, which is the rule the Android implementation punishes breaking.
 * Both platforms report the three together for a camera with a flash unit and
 * none of them for a camera without one, so in practice this reads as "does
 * this camera have a flash".
 *
 * `torch` is never one of them: a camera with only a lamp answers `["torch"]`,
 * and iOS models the lamp as a separate one-way state from the capture flash.
 * `red-eye` sits in the plugin's type union with nothing behind it on iOS.
 */
const CYCLED_FLASH_MODES: FlashMode[] = ["off", "auto", "on"];

/**
 * The "this camera cannot flash" answer, as one shared value.
 *
 * Clearing the probe result happens on every acquire and every flip, and a
 * fresh `[]` each time would be a new identity and so a re-render each time.
 */
const NO_FLASH_MODES: string[] = [];

/**
 * The newest native start or stop any instance of this hook posted to the
 * bridge, corrected to "stop" when a start reports failure with nothing newer
 * behind it. Module-scoped because the native preview is one plugin instance
 * shared across hook instances (the room and the capture overlay), so a stale
 * start deciding whether its cleanup is safe cannot consult its own refs: the
 * newest call can belong to an instance it has never seen. When the newest
 * call is a start, an unscoped stop tears down the preview that start raises;
 * when it is a stop, one more stop is harmless.
 */
let lastNativePreviewCall: "start" | "stop" = "stop";

/**
 * Counts the calls the ledger describes, so a failed start can tell whether
 * it is still the newest one before it downgrades the ledger: when a newer
 * call sits behind it on the bridge, the ledger is that call's to describe.
 */
let nativePreviewCallSeq = 0;

/** Record a native start or stop posted to the bridge, returning its seq. */
function recordNativePreviewCall(call: "start" | "stop"): number {
  lastNativePreviewCall = call;
  return ++nativePreviewCallSeq;
}

/**
 * Whether a viewfinder can run in this environment.
 *
 * Native mobile shells can provide the Capacitor preview even when the web
 * media API is unavailable. The actual bridge call remains skew-safe and
 * falls through to `getUserMedia` when an older shell lacks the plugin.
 */
export function isVoiceCameraSupported(): boolean {
  return (
    isNativeMobile() ||
    (typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia)
  );
}

function classifyError(cause: unknown): VoiceCameraError {
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

/**
 * Draw the video's current frame to a canvas and encode it as a JPEG `File`.
 *
 * Exported for tests. Returns null when the element has no frame yet: a
 * `<video>` reports `videoWidth === 0` until the first frame decodes, and
 * encoding that would upload a blank image.
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  filename: string,
): Promise<File | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.toBlob !== "function") {
    return null;
  }

  try {
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", CAPTURE_JPEG_QUALITY);
    });
    if (!blob) {
      return null;
    }
    return new File([blob], filename, { type: "image/jpeg" });
  } catch {
    // A tainted canvas is the only realistic throw here, and it cannot happen
    // for a same-origin `getUserMedia` stream. Fail as "no frame" rather than
    // taking the call down.
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export interface VoiceCamera {
  /** True once a camera preview is live. */
  readonly open: boolean;
  /**
   * True while a flip is swapping the capture under the open viewfinder. On
   * the fallback path the flip releases one stream and awaits the
   * replacement, and `open` holds true across that gap, so a capture pressed
   * there has nothing to encode. Surfaces disable the shutter on this rather
   * than report the press as a capture failure.
   */
  readonly flipping: boolean;
  /** True when the preview is a native layer behind the Capacitor web view. */
  readonly native: boolean;
  /** Which way the camera currently points. */
  readonly facing: VoiceCameraFacing;
  /**
   * True while the camera that is running can fire a flash for a capture.
   *
   * False for a surface that did not ask for the flash, false on the browser
   * fallback path, and false while a native camera with no flash unit is up, so
   * the control is offered only where it does something. The mode itself is the
   * persisted `flashMode` preference, applied to the camera by this hook
   * whenever one that can take it arrives.
   */
  readonly flashAvailable: boolean;
  /** Why the last `openCamera()` failed, or null. Cleared on the next attempt. */
  readonly error: VoiceCameraError | null;
  /** Request camera access and start the viewfinder. Call directly from a tap. */
  openCamera: () => Promise<void>;
  /** Release the camera. Idempotent. */
  closeCamera: () => void;
  /** Switch between front and rear cameras, keeping the viewfinder open. */
  flipCamera: () => Promise<void>;
  /** Encode the current frame, or null if there is nothing to capture. */
  captureFrame: () => Promise<File | null>;
}

export interface VoiceCameraOptions {
  /**
   * Whether this surface drives the flash. Off by default.
   *
   * Opt-in rather than automatic because the flash is a preference the user
   * sets from a control, and a surface that shows no control would be firing a
   * flash the person holding the phone can neither see coming nor turn off from
   * where they are. The composer's capture overlay is that surface; the voice
   * room, which offers the control, is the one that opts in.
   */
  flash?: boolean;
}

/**
 * Owns the viewfinder capture for as long as the component holding it is
 * mounted. Unmounting releases the camera, which is what makes the room's
 * minimize (and the end of the call) turn the camera hardware off without
 * anything having to remember to.
 *
 * The caller owns the `<video>` ref and passes it in, rather than receiving
 * one back. Handing a ref out through a returned object makes React's
 * `react-hooks/refs` rule treat that whole object as a ref, so the consumer
 * cannot read plain state like `open` or `facing` during render without being
 * flagged. The caller keeping its own ref and wiring `ref={videoRef}` in JSX
 * is the shape the rule is written for.
 */
export function useVoiceCamera(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { flash = false }: VoiceCameraOptions = {},
): VoiceCamera {
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<"native-pending" | "native" | "web" | null>(null);
  const captureCountRef = useRef(0);
  // Bumped by every acquire and every release, so a `getUserMedia` that
  // resolves after it was superseded can tell and stop its own stream.
  const acquireEpochRef = useRef(0);
  // Which camera the flash probe is asking about. Versioned separately from
  // the acquire epoch because a native flip swaps the camera WITHOUT releasing
  // the capture, so the acquire epoch alone would let a probe of the outgoing
  // camera answer for the one that replaced it.
  const flashProbeEpochRef = useRef(0);
  // The flip that is running, as its own identity, or null for none. See
  // `flipCamera`: two of them overlapping spin the hardware twice and agree on
  // the wrong answer. An identity rather than a flag because an external
  // release drops the claim (see `releaseCamera`), and a flip that resumes
  // after that must not drop the claim of the flip that replaced it.
  const flipInFlightRef = useRef<object | null>(null);
  // True while a flash-capable camera is running with a mode other than off,
  // which is exactly when the plugin has state of ours to hand back. Cleared
  // rather than re-derived, so a camera that turned out to have no flash is
  // never sent a `setFlashMode` it would throw on.
  const flashEngagedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [flipping, setFlipping] = useState(false);
  const [native, setNative] = useState(false);
  const [facing, setFacing] = useState<VoiceCameraFacing>("environment");
  const [error, setError] = useState<VoiceCameraError | null>(null);
  const [supportedFlashModes, setSupportedFlashModes] =
    useState<string[]>(NO_FLASH_MODES);
  const flashMode = useVoicePrefsStore.use.flashMode();

  /**
   * Tear the running capture down.
   *
   * Every path that stops the hardware goes through here, including the flip's
   * own reacquisition, so it deliberately says nothing about the flip claim:
   * that belongs to {@link releaseCamera}, which is the external half.
   */
  const stopCapture = useCallback(() => {
    // Cancels any acquire still in flight, so its stream is stopped on arrival
    // rather than installed behind this release, and any flash probe still in
    // flight, whose camera is the one going away here.
    acquireEpochRef.current++;
    flashProbeEpochRef.current++;
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source === "native-pending" || source === "native") {
      // Hand the flash back BEFORE the stop, never after: both flash calls
      // reach for the capture device the stop releases. Neither call is
      // awaited, and neither needs to be, because the bridge delivers messages
      // in the order the same tick posted them.
      if (flashEngagedRef.current) {
        flashEngagedRef.current = false;
        void setNativeVoiceCameraFlashMode("off");
      }
      recordNativePreviewCall("stop");
      void stopNativeVoiceCamera();
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [videoRef]);

  /**
   * Give the camera up on someone else's say-so: the user closing the
   * viewfinder, or the component going away.
   *
   * This is the only thing that abandons a running flip's claim, and it has to
   * be. Nothing else clears the claim of a bridge call that never comes back,
   * so a flip left marked in flight is a flip button that never works again,
   * across a close and a reopen included. A flip's *own* reacquisition calls
   * `stopCapture` directly instead: on the fallback path the flip releases the
   * capture to request the other camera, and dropping its claim there would
   * leave the guard open for a second tap to start a competing flip while the
   * first one is still mid-await.
   */
  const releaseCamera = useCallback(() => {
    flipInFlightRef.current = null;
    setFlipping(false);
    stopCapture();
  }, [stopCapture]);

  /**
   * Ask the camera that is running what it can do with its flash.
   *
   * Every path that changes which camera is running clears the answer first and
   * calls this after, because the answer belongs to one camera and a flip
   * changes which one that is. A late answer is dropped: the probe epoch moves
   * on every release, every acquire and every flip, so a probe that resolves
   * after the camera it asked about stopped being the active one cannot speak
   * for the one that replaced it. A flip is the case that needs its own epoch:
   * it swaps cameras without releasing the capture, so `sourceRef` still reads
   * `native` and the acquire epoch still reads unchanged while the camera under
   * the outstanding probe is already gone.
   *
   * A surface that did not opt into the flash never asks, which leaves the
   * supported list empty and every other flash path in this hook inert.
   */
  const probeFlash = useCallback(async () => {
    if (!flash) {
      return;
    }
    const epoch = flashProbeEpochRef.current;
    const modes = await getNativeVoiceCameraFlashModes();
    if (
      epoch !== flashProbeEpochRef.current ||
      sourceRef.current !== "native"
    ) {
      return;
    }
    setSupportedFlashModes(modes.length > 0 ? modes : NO_FLASH_MODES);
  }, [flash]);

  /**
   * Acquire one camera and attach it. Returns the failure rather than
   * surfacing it, so a flip can try to fall back before anything reaches the
   * user.
   *
   * Releases the current capture BEFORE requesting the replacement. Phones
   * routinely cannot hold the front and rear cameras open at once, so
   * requesting the second while the first is live fails with
   * `NotReadableError`, and unwinding from there is what would strand a live
   * stream behind a closed viewfinder, leaving the camera indicator lit with
   * nothing on screen.
   */
  const acquire = useCallback(
    async (nextFacing: VoiceCameraFacing): Promise<VoiceCameraError | null> => {
      stopCapture();
      // Whatever the outgoing camera could do says nothing about the incoming
      // one, and a stale "yes" here is what would put a `setFlashMode` on a
      // camera that has not been probed yet.
      setSupportedFlashModes(NO_FLASH_MODES);
      // Snapshot the epoch across the await. Anything that releases the camera
      // while this request is in flight (unmount, close, a second tap, a flip)
      // bumps it, and the stream that eventually arrives belongs to nobody:
      // the cleanup it should have been caught by has already run against an
      // empty `streamRef`. Assigning it there would leave the hardware live
      // with no owner, which is the camera staying on after the room closes.
      // Same guard, and the same reason, as `pcm-capture.ts`'s cancel epoch.
      const epoch = ++acquireEpochRef.current;

      if (isNativeMobile()) {
        sourceRef.current = "native-pending";
        const nativeCallSeq = recordNativePreviewCall("start");
        const started = await startNativeVoiceCamera(nextFacing);
        if (epoch !== acquireEpochRef.current) {
          // A canceled start still owns what it started, unless something
          // newer holds a claim. The release that canceled this acquire posts
          // a stop of its own, but that stop can reach the native side before
          // this start finishes there and stop nothing, which is hardware
          // left live with no owner; stopping here closes that hole. When the
          // newest call on the bridge is another start, in this instance or
          // any other, the opposite holds: that start sits behind this one on
          // the bridge, and an unscoped stop posted now lands after it,
          // tearing down the very preview it is installing.
          if (started && lastNativePreviewCall === "stop") {
            await stopNativeVoiceCamera();
          }
          return "aborted";
        }
        if (started) {
          sourceRef.current = "native";
          setNative(true);
          setFacing(nextFacing);
          // Not awaited: the viewfinder is already live and the flash control
          // is allowed to arrive a beat after it. Awaiting would hold the
          // whole open behind a round trip that only decides one button.
          void probeFlash();
          return null;
        }
        sourceRef.current = null;
        // A failed start raises nothing, so while it is still the ledger's
        // newest call it stops reading as a live preview a stale sibling
        // must spare.
        if (nativeCallSeq === nativePreviewCallSeq) {
          lastNativePreviewCall = "stop";
        }
      }

      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        return "unsupported";
      }

      let stream: MediaStream;
      try {
        // Video only. See the module docstring: adding `audio` here would
        // renegotiate the microphone the call is already streaming from.
        //
        // `facingMode` is a plain (non-`exact`) constraint so a device with
        // one camera (most laptops) still opens it instead of failing with
        // OverconstrainedError.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: nextFacing,
            width: { ideal: VIEWFINDER_IDEAL_WIDTH },
            height: { ideal: VIEWFINDER_IDEAL_HEIGHT },
          },
        });
      } catch (cause) {
        // Superseded requests report as superseded whether they succeeded or
        // failed. A rejection that lands after a close is not news the user
        // needs, and reporting it as a real failure is what would send the web
        // flip path into a fallback acquire of a camera nobody has open.
        if (epoch !== acquireEpochRef.current) {
          return "aborted";
        }
        return classifyError(cause);
      }

      if (epoch !== acquireEpochRef.current) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return "aborted";
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const { width, height, aspectRatio, frameRate, facingMode } =
          videoTrack.getSettings();
        // Keep deviceId and groupId out of the console: the dimensions are
        // enough to verify what the browser negotiated.
        console.debug("[voice-camera] negotiated video track", {
          width,
          height,
          aspectRatio,
          frameRate,
          facingMode,
        });
      }

      streamRef.current = stream;
      sourceRef.current = "web";
      setNative(false);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setFacing(nextFacing);
      return null;
    },
    [probeFlash, stopCapture, videoRef],
  );

  const start = useCallback(
    async (nextFacing: VoiceCameraFacing): Promise<void> => {
      if (!isVoiceCameraSupported()) {
        setError("unsupported");
        setOpen(false);
        return;
      }

      const failure = await acquire(nextFacing);
      // A superseded acquire touches no state: the close or the later tap that
      // cancelled it already set the state it wanted, and reporting a failure
      // here would overwrite that with an error for something the user did on
      // purpose.
      if (failure === "aborted") {
        return;
      }
      if (failure) {
        setError(failure);
        setOpen(false);
        return;
      }
      setError(null);
      setOpen(true);
    },
    [acquire],
  );

  const openCamera = useCallback(async () => {
    await start(facing);
  }, [facing, start]);

  const closeCamera = useCallback(() => {
    releaseCamera();
    setOpen(false);
    setNative(false);
    setError(null);
    setSupportedFlashModes(NO_FLASH_MODES);
  }, [releaseCamera]);

  /**
   * Switch cameras, keeping the viewfinder up.
   *
   * A failed flip reopens the camera the user already had. Flipping is a
   * convenience: a device that turns out to have only one usable camera
   * should leave the user aiming the one that works, not close the viewfinder
   * mid-conversation and make them find the button again.
   *
   * Every await here is a place the capture can be released and replaced under
   * the flip, so the acquire epoch is snapshotted up front and rechecked after
   * each one. A flip that resumes onto a preview it did not open would spin a
   * viewfinder the user just raised and file the capabilities it then probes
   * under a camera nobody asked about.
   *
   * One flip at a time, for a reason the epoch cannot cover: a native flip
   * swaps cameras without releasing the capture, so a second flip entering
   * while the first is mid-await shares its generation AND reads the same
   * pre-flip `facing`. Both would compute the same `next`, spin the hardware
   * twice back to where it started, and leave the hook reporting the far side,
   * which is a viewfinder mirrored the wrong way and every later flip working
   * from a facing the camera does not have. Dropping the second tap is also
   * what the user meant by it.
   *
   * The claim survives this flip's own reacquisition. On the fallback path
   * `acquire` releases the capture before requesting the replacement, and
   * `sourceRef` reads `native-pending` across that await, so a claim dropped
   * there would leave both guards open for a second tap. Only `releaseCamera`
   * abandons a claim, which is why `acquire` calls `stopCapture` directly.
   */
  const flipCamera = useCallback(async () => {
    if (!sourceRef.current || flipInFlightRef.current) {
      return;
    }
    const claim = {};
    flipInFlightRef.current = claim;
    setFlipping(true);
    try {
      // Before anything else, and before the flip itself: from here on the
      // camera any outstanding probe asked about is not the one that will be
      // running, and a late "yes" from it is exactly the unprobed
      // `setFlashMode` the Android implementation throws on.
      flashProbeEpochRef.current++;
      // Which capture this flip belongs to. Every release bumps it, so it is
      // also the token for "the camera I started on is still the one running".
      const generation = acquireEpochRef.current;
      const previous = facing;
      const next = previous === "environment" ? "user" : "environment";

      if (sourceRef.current === "native") {
        // Give the flash back while the camera that has one is still the
        // active camera. Neither platform carries the mode across a flip, and
        // iOS keeps its own copy of it, which the camera arriving may have no
        // way to fire.
        if (flashEngagedRef.current) {
          flashEngagedRef.current = false;
          await setNativeVoiceCameraFlashMode("off");
          // A close and a reopen fit inside that round trip, and the preview
          // on the other side of it is a different operation's.
          if (generation !== acquireEpochRef.current) {
            return;
          }
        }
        setSupportedFlashModes(NO_FLASH_MODES);
        const flipped = await flipNativeVoiceCamera();
        // Whatever released the camera during the flip owns the state now,
        // including the facing this would otherwise announce.
        if (generation !== acquireEpochRef.current) {
          return;
        }
        if (flipped) {
          setFacing(next);
        }
        // Re-probed whether or not the flip took: on a failure the old camera
        // is still running and its capabilities were just cleared. Not awaited,
        // so the flip is available again the moment the flip itself settles;
        // the probe epoch is what makes a late answer safe, and the next flip
        // bumps it before anything else.
        void probeFlash();
        return;
      }

      const failure = await acquire(next);
      if (!failure || failure === "aborted") {
        return;
      }
      // The replacement failed and the old capture is already released, so the
      // fallback is a fresh acquire of what was running a moment ago.
      const fallbackFailure = await acquire(previous);
      if (fallbackFailure && fallbackFailure !== "aborted") {
        setError(fallbackFailure);
        setOpen(false);
      }
    } finally {
      // This flip's own claim only. A release landing mid-flip already dropped
      // it, and the claim standing now may belong to the flip that came after,
      // whose `flipping` this must also leave standing.
      if (flipInFlightRef.current === claim) {
        flipInFlightRef.current = null;
        setFlipping(false);
      }
    }
  }, [acquire, facing, probeFlash]);

  const captureFrame = useCallback(async () => {
    const filename = `photo-${captureCountRef.current + 1}.jpg`;
    let file: File | null = null;

    if (sourceRef.current === "native") {
      const encoded = await captureNativeVoiceCameraFrame(
        Math.round(CAPTURE_JPEG_QUALITY * 100),
      );
      if (encoded) {
        try {
          const dataUri = encoded.startsWith("data:")
            ? encoded
            : `data:image/jpeg;base64,${encoded}`;
          const bytes = dataUriToUint8Array(dataUri);
          if (bytes) {
            file = new File([bytes], filename, {
              type: "image/jpeg",
            });
          }
        } catch {
          return null;
        }
      }
    } else {
      const video = videoRef.current;
      if (!video || !streamRef.current) {
        return null;
      }
      file = await captureVideoFrame(video, filename);
    }

    // Numbered per session rather than timestamped: the name is what the
    // transcript labels the photo with, and "Photo 2" reads as the second one
    // taken, which is exactly what the user is looking for when they scroll
    // back. Incremented only on a frame that actually encoded.
    if (file) {
      captureCountRef.current += 1;
    }
    return file;
  }, [videoRef]);

  // The capture outlives React's own teardown of the element, so releasing
  // the hardware has to be explicit. Without this the camera light stays on
  // after the room closes.
  useEffect(() => releaseCamera, [releaseCamera]);

  // The `<video>` renders on the same commit that flips `open`, so a stream
  // acquired in `start()` has no element to attach to yet. This runs after
  // that commit, which is the first moment there is one.
  useEffect(() => {
    if (open && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [open, videoRef]);

  const flashAvailable =
    native &&
    CYCLED_FLASH_MODES.every((mode) => supportedFlashModes.includes(mode));

  // Put the user's preference on whatever camera can take it, and take it back
  // off the moment one cannot.
  //
  // Keyed on the capability rather than on the open, so it covers all three
  // moments that need it with one rule: the camera opening, the user cycling
  // the control, and a flip landing on a camera that answered the probe
  // differently. `off` is stated as explicitly as the other two rather than
  // assumed, because the hand-back on the way out is best effort and the mode
  // it failed to clear is one this camera would otherwise open holding.
  useEffect(() => {
    if (!flashAvailable) {
      flashEngagedRef.current = false;
      return;
    }
    flashEngagedRef.current = flashMode !== "off";
    void setNativeVoiceCameraFlashMode(flashMode);
  }, [flashAvailable, flashMode]);

  return {
    open,
    flipping,
    native,
    facing,
    flashAvailable,
    error,
    openCamera,
    closeCamera,
    flipCamera,
    captureFrame,
  };
}
