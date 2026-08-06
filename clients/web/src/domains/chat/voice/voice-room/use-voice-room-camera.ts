/**
 * The voice room's shutter: turns the open viewfinder into a photo the running
 * call can see.
 *
 * Deliberately made of parts that already exist. A captured frame is a `File`,
 * which is exactly what a typed message's attachment is, so it goes through the
 * same two steps the composer's paperclip uses —
 * {@link prepareImageAttachmentForUpload} then {@link uploadChatAttachment} —
 * and lands in the same store, with the same HEIF/size handling and the same
 * transcript rendering. Only the last step is voice-specific: the returned id
 * is handed to the live-voice session, which parks it and attaches it to the
 * next turn's user message.
 *
 * That parking is what makes the interaction work in the order people use it.
 * Whether the user snaps and then asks, or asks and then snaps, the photo and
 * the sentence resolve to a single turn — a bare "what's this?" is answered
 * about the picture rather than about nothing.
 */

import { useCallback, useState } from "react";

import { uploadChatAttachment } from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import { attachLiveVoiceImage } from "@/domains/chat/voice/live-voice/live-voice-store";
import { captureError } from "@/lib/sentry/capture-error";

import { useVoiceCamera, type VoiceCamera } from "./voice-camera";

/**
 * What the room tells the user when the camera or a photo fails. Short and
 * plain: it is read at a glance, over a live call, by someone holding a phone
 * up at something.
 */
const CAMERA_ERROR_COPY: Record<string, string> = {
  "permission-denied": "Camera access is off for Vellum.",
  "no-device": "No camera found.",
  "device-in-use": "Another app is using the camera.",
  unsupported: "This device can't open a camera.",
  unknown: "Couldn't open the camera.",
  "capture-failed": "Couldn't take that photo.",
  "upload-failed": "Couldn't send that photo.",
};

export interface VoiceRoomCamera {
  readonly camera: VoiceCamera;
  /** True while a captured frame is being prepared and uploaded. */
  readonly sending: boolean;
  /** User-facing failure for the camera or the last photo, or null. */
  readonly errorMessage: string | null;
  /** Capture the current frame, upload it, and hand it to the session. */
  readonly shutter: () => Promise<void>;
  /** Open the viewfinder. Call directly from a tap (iOS permission alert). */
  readonly open: () => Promise<void>;
  /** Close the viewfinder and release the camera. */
  readonly close: () => void;
}

export function useVoiceRoomCamera(
  assistantId: string | null,
  /** The room's own ref for the viewfinder `<video>`. See {@link useVoiceCamera}. */
  videoRef: React.RefObject<HTMLVideoElement | null>,
): VoiceRoomCamera {
  const camera = useVoiceCamera(videoRef);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const shutter = useCallback(async () => {
    if (!assistantId || sending) {
      return;
    }
    setSendError(null);
    setSending(true);
    try {
      const frame = await camera.captureFrame();
      if (!frame) {
        setSendError("capture-failed");
        return;
      }

      // The same preparation a pasted or dragged image gets. A viewfinder
      // frame is normally already under the auto-resize threshold, so this is
      // usually a pass-through — it is here so the one path that isn't (a
      // high-resolution track on a recent phone) behaves like every other
      // attachment rather than like a special case.
      const prepared = await prepareImageAttachmentForUpload(frame);
      const file = prepared.status === "failed" ? frame : prepared.file;

      const uploaded = await uploadChatAttachment(assistantId, file);
      if (!uploaded.ok) {
        setSendError("upload-failed");
        return;
      }

      attachLiveVoiceImage(uploaded.id);
    } catch (error) {
      captureError(error, {
        context: "voice-room camera: capture/upload photo",
      });
      setSendError("upload-failed");
    } finally {
      setSending(false);
    }
  }, [assistantId, camera, sending]);

  const open = useCallback(async () => {
    setSendError(null);
    await camera.openCamera();
  }, [camera]);

  const close = useCallback(() => {
    setSendError(null);
    camera.closeCamera();
  }, [camera]);

  // The camera's own failure wins over a stale photo failure: if the viewfinder
  // is not running, "couldn't send that photo" describes the wrong problem.
  const errorKey = camera.error ?? sendError;

  return {
    camera,
    sending,
    errorMessage: errorKey
      ? (CAMERA_ERROR_COPY[errorKey] ?? CAMERA_ERROR_COPY.unknown!)
      : null,
    shutter,
    open,
    close,
  };
}
