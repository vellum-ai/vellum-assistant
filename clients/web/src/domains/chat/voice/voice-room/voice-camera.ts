/**
 * The voice room's camera: a live viewfinder the user can leave open for the
 * whole call, and a shutter that turns the current frame into a `File`.
 *
 * ## Why this is not the system camera
 *
 * On iOS the obvious move (`<input type="file" capture="environment">`, which
 * raises Apple's own camera) is wrong for this feature in three ways: it is
 * modal and one-shot, so every photo costs a full open/aim/expose cycle; it
 * covers the room, so the call it belongs to disappears while you use it; and
 * it puts the OS in charge of an audio session that a call is currently
 * holding. A viewfinder the room owns is a `<video>` element, which does none
 * of that and stays open across as many photos as the user wants to take.
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
 * `open()` calls `getUserMedia` directly so the tap that opens the camera is
 * the thing that raises the OS alert, per docs/CAPACITOR.md § OS permission
 * requests on iOS. Nothing dismissible may sit between the two, so the room
 * offers a plain camera button rather than an explanatory sheet.
 */

import { useCallback, useEffect, useRef, useState } from "react";

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
 * JPEG quality for a captured frame. A viewfinder frame is already only as big
 * as the negotiated video track (typically 1280×720), so this lands well under
 * the attachment pipeline's 3.5 MB auto-resize threshold and
 * `prepareImageAttachmentForUpload` passes it through untouched. Quality is
 * chosen for a model reading the image, not for a photo library.
 */
const CAPTURE_JPEG_QUALITY = 0.85;

/**
 * Whether a viewfinder can run in this environment.
 *
 * Pure feature detection per docs/CAPACITOR.md § Platform short-circuits.
 * Capacitor iOS is a WKWebView that ships `getUserMedia` for video, so there
 * is no platform branch here.
 */
export function isVoiceCameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
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
  /** True once a stream is live and attached. */
  readonly open: boolean;
  /** Which way the camera currently points. */
  readonly facing: VoiceCameraFacing;
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

/**
 * Owns the viewfinder's `MediaStream` for as long as the component holding it
 * is mounted. Unmounting releases the camera, which is what makes the room's
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
): VoiceCamera {
  const streamRef = useRef<MediaStream | null>(null);
  const captureCountRef = useRef(0);
  // Bumped by every acquire and every release, so a `getUserMedia` that
  // resolves after it was superseded can tell and stop its own stream.
  const acquireEpochRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [facing, setFacing] = useState<VoiceCameraFacing>("environment");
  const [error, setError] = useState<VoiceCameraError | null>(null);

  const stopStream = useCallback(() => {
    // Cancels any acquire still in flight, so its stream is stopped on arrival
    // rather than installed behind this release.
    acquireEpochRef.current++;
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
      stopStream();
      // Snapshot the epoch across the await. Anything that releases the camera
      // while this request is in flight (unmount, close, a second tap, a flip)
      // bumps it, and the stream that eventually arrives belongs to nobody:
      // the cleanup it should have been caught by has already run against an
      // empty `streamRef`. Assigning it there would leave the hardware live
      // with no owner, which is the camera staying on after the room closes.
      // Same guard, and the same reason, as `pcm-capture.ts`'s cancel epoch.
      const epoch = ++acquireEpochRef.current;

      let stream: MediaStream;
      try {
        // Video only. See the module docstring: adding `audio` here would
        // renegotiate the microphone the call is already streaming from.
        //
        // `facingMode` is a plain (non-`exact`) constraint so a device with
        // one camera (most laptops) still opens it instead of failing with
        // OverconstrainedError.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: nextFacing },
        });
      } catch (cause) {
        return classifyError(cause);
      }

      if (epoch !== acquireEpochRef.current) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return "aborted";
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setFacing(nextFacing);
      return null;
    },
    [stopStream, videoRef],
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
    stopStream();
    setOpen(false);
    setError(null);
  }, [stopStream]);

  /**
   * Switch cameras, keeping the viewfinder up.
   *
   * A failed flip reopens the camera the user already had. Flipping is a
   * convenience: a device that turns out to have only one usable camera
   * should leave the user aiming the one that works, not close the viewfinder
   * mid-conversation and make them find the button again.
   */
  const flipCamera = useCallback(async () => {
    if (!isVoiceCameraSupported() || !streamRef.current) {
      return;
    }
    const previous = facing;
    const next = previous === "environment" ? "user" : "environment";

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
  }, [acquire, facing]);

  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !streamRef.current) {
      return null;
    }
    // Numbered per session rather than timestamped: the name is what the
    // transcript labels the photo with, and "Photo 2" reads as the second one
    // taken, which is exactly what the user is looking for when they scroll
    // back. Incremented only on a frame that actually encoded.
    const file = await captureVideoFrame(
      video,
      `photo-${captureCountRef.current + 1}.jpg`,
    );
    if (file) {
      captureCountRef.current += 1;
    }
    return file;
  }, [videoRef]);

  // The stream outlives React's own teardown of the element, so releasing the
  // hardware has to be explicit. Without this the camera light stays on after
  // the room closes.
  useEffect(() => stopStream, [stopStream]);

  // The `<video>` renders on the same commit that flips `open`, so a stream
  // acquired in `start()` has no element to attach to yet. This runs after
  // that commit, which is the first moment there is one.
  useEffect(() => {
    if (open && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [open, videoRef]);

  return {
    open,
    facing,
    error,
    openCamera,
    closeCamera,
    flipCamera,
    captureFrame,
  };
}
