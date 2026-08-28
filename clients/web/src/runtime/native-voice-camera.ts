/**
 * Native camera preview bridge for the voice room.
 *
 * The native preview is inserted behind the Capacitor web view. The root class
 * makes the web canvas transparent while the voice room keeps its controls in
 * front. Calls are intentionally failure-tolerant because a newly deployed web
 * bundle can run inside an older installed shell that does not have this plugin.
 */

import { CameraPreview } from "@capacitor-community/camera-preview";

import { callNativeVoice } from "@/runtime/native-voice";
import { isNativeMobile } from "@/runtime/platform-detection";

export type NativeVoiceCameraFacing = "environment" | "user";

export const NATIVE_VOICE_CAMERA_ACTIVE_CLASS = "native-voice-camera-active";

function setPreviewVisible(visible: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.toggle(
    NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
    visible,
  );
}

/**
 * Counts every start and stop, so a start whose refusal arrives late can tell
 * that the visibility is not its to clean: when a stop and a replacement
 * start run while the refusal is on the bridge, hiding the preview here would
 * hide the replacement's, with its camera live behind an opaque canvas.
 */
let visibilityEpoch = 0;

/** Start the native preview, or return false when this shell cannot provide it. */
export async function startNativeVoiceCamera(
  facing: NativeVoiceCameraFacing,
): Promise<boolean> {
  if (!isNativeMobile()) {
    return false;
  }

  const epoch = ++visibilityEpoch;
  setPreviewVisible(true);
  const started = await callNativeVoice(async () => {
    await CameraPreview.start({
      position: facing === "environment" ? "rear" : "front",
      toBack: true,
      storeToFile: false,
      enableHighResolution: true,
      disableAudio: true,
      enableZoom: true,
    });
    return true;
  }, false);
  if (!started && epoch === visibilityEpoch) {
    setPreviewVisible(false);
  }
  return started;
}

/** Stop the native preview. Safe when the plugin is absent or already stopped. */
export async function stopNativeVoiceCamera(): Promise<void> {
  visibilityEpoch += 1;
  setPreviewVisible(false);
  await callNativeVoice(async () => {
    await CameraPreview.stop();
  }, undefined);
}

/** Capture a native JPEG as base64, or null when capture fails. */
export async function captureNativeVoiceCameraFrame(
  quality: number,
): Promise<string | null> {
  return callNativeVoice(async () => {
    const { value } = await CameraPreview.capture({ quality });
    return value || null;
  }, null);
}

/** Flip the active native camera, returning whether the switch succeeded. */
export async function flipNativeVoiceCamera(): Promise<boolean> {
  return callNativeVoice(async () => {
    await CameraPreview.flip();
    return true;
  }, false);
}

/**
 * Which flash modes the camera that is running RIGHT NOW supports.
 *
 * Both mobile implementations answer a camera with no flash unit (most front
 * cameras) with an empty list rather than failing, so `[]` is the honest answer
 * to "can this camera flash at all" and not only the skew fallback.
 *
 * Only meaningful between a resolved {@link startNativeVoiceCamera} and the
 * matching {@link stopNativeVoiceCamera}: outside that window one platform
 * rejects and the other answers for a stopped camera.
 */
export async function getNativeVoiceCameraFlashModes(): Promise<string[]> {
  return callNativeVoice(async () => {
    const { result } = await CameraPreview.getSupportedFlashModes();
    return Array.isArray(result) ? result : [];
  }, []);
}

/**
 * Set the flash mode the next capture will fire with, returning whether it took.
 *
 * Call this ONLY with a mode {@link getNativeVoiceCameraFlashModes} has just
 * reported for the active camera. The Android implementation reads the
 * supported-mode list without a null check, and that list is null on a camera
 * with no flash, so a speculative call throws out of the bridge rather than
 * rejecting into the fallback below.
 */
export async function setNativeVoiceCameraFlashMode(
  mode: string,
): Promise<boolean> {
  return callNativeVoice(async () => {
    await CameraPreview.setFlashMode({ flashMode: mode });
    return true;
  }, false);
}
