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

export const NATIVE_VOICE_CAMERA_ACTIVE_CLASS =
  "native-voice-camera-active";

function setPreviewVisible(visible: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.toggle(
    NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
    visible,
  );
}

/** Start the native preview, or return false when this shell cannot provide it. */
export async function startNativeVoiceCamera(
  facing: NativeVoiceCameraFacing,
): Promise<boolean> {
  if (!isNativeMobile()) {
    return false;
  }

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
  if (!started) {
    setPreviewVisible(false);
  }
  return started;
}

/** Stop the native preview. Safe when the plugin is absent or already stopped. */
export async function stopNativeVoiceCamera(): Promise<void> {
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
