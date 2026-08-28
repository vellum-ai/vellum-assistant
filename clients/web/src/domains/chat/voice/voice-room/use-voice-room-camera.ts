/**
 * The voice room's shutter: turns the open viewfinder into a photo the running
 * call can see.
 *
 * Deliberately made of parts that already exist. A captured frame is a `File`,
 * which is exactly what a typed message's attachment is, so it goes through the
 * same two steps the composer's paperclip uses,
 * {@link prepareImageAttachmentForUpload} then {@link uploadChatAttachment},
 * and lands in the same store, with the same HEIF/size handling and the same
 * transcript rendering. Only the last step is voice-specific: the returned id
 * is handed to the live-voice session, which persists it into the
 * conversation as its own user message and runs no turn for it.
 *
 * Running no turn is what makes the interaction work in the order people use
 * it. Whether the user snaps and then asks, or asks and then snaps, the model
 * has the image in history by the time it answers, and nothing races the
 * sentence they are in the middle of saying.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { uploadChatAttachment } from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import {
  attachLiveVoiceImage,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { captureError } from "@/lib/sentry/capture-error";

import { useVoiceCamera, type VoiceCamera } from "./voice-camera";

/** The catalog keys this hook can hand back. See {@link CAMERA_ERROR_KEYS}. */
export type CameraErrorKey =
  | "cameraError.permissionDenied"
  | "cameraError.noDevice"
  | "cameraError.deviceInUse"
  | "cameraError.unsupported"
  | "cameraError.unknown"
  | "cameraError.captureFailed"
  | "cameraError.uploadFailed"
  | "cameraError.notDelivered"
  | "cameraError.refused"
  | "cameraError.storeFailed";

/**
 * What the room tells the user when the camera or a photo fails, as a catalog
 * key. Short and plain copy: it is read at a glance, over a live call, by
 * someone holding a phone up at something.
 *
 * Keys rather than sentences because this module is a hook, not a component,
 * and the room is where a translator's `t` already is. Same reason the status
 * pill takes the session's word as a key: one decision table, translated once,
 * at the surface that renders it.
 */
const CAMERA_ERROR_KEYS: Record<string, CameraErrorKey> = {
  "permission-denied": "cameraError.permissionDenied",
  "no-device": "cameraError.noDevice",
  "device-in-use": "cameraError.deviceInUse",
  unsupported: "cameraError.unsupported",
  unknown: "cameraError.unknown",
  "capture-failed": "cameraError.captureFailed",
  "upload-failed": "cameraError.uploadFailed",
  "not-delivered": "cameraError.notDelivered",
  refused: "cameraError.refused",
  "store-failed": "cameraError.storeFailed",
};

/**
 * How many recent photos the room keeps on screen.
 *
 * Three, because the strip is a receipt and not a gallery: it answers "did
 * that go?" for the shot just taken and the couple before it, which is the
 * span a caller is still talking about. Older ones are in the transcript,
 * which is where looking back belongs.
 */
const VISIBLE_PHOTOS = 3;

export type VoiceRoomPhotoStatus = "sending" | "sent" | "failed";

export interface VoiceRoomPhoto {
  readonly id: number;
  /** Object URL of the captured frame. Revoked when the photo is dropped. */
  readonly previewUrl: string;
  readonly status: VoiceRoomPhotoStatus;
}

export interface VoiceRoomCamera {
  readonly camera: VoiceCamera;
  /** True while a captured frame is being prepared and uploaded. */
  readonly sending: boolean;
  /**
   * The most recent photos, oldest first, capped at {@link VISIBLE_PHOTOS}.
   *
   * This is the feature's only confirmation that a shutter press did
   * anything. Without it a photo is taken into silence: the viewfinder does
   * not change, the assistant may not speak for seconds, and the transcript
   * is behind the room.
   */
  readonly photos: readonly VoiceRoomPhoto[];
  /**
   * Catalog key for the camera's or the last photo's failure, or null.
   * Translated by the room, which is where the copy is read.
   */
  readonly errorKey: CameraErrorKey | null;
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
  // The room is the surface that offers the flash control, so it is the one
  // that drives the flash. See `voice-camera.ts` for why that is opt-in.
  const camera = useVoiceCamera(videoRef, { flash: true });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<readonly VoiceRoomPhoto[]>([]);
  const nextPhotoId = useRef(0);
  const photoRejectedSeq = useLiveVoiceStore.use.photoRejectedSeq();
  const photoRejectedReason = useLiveVoiceStore.use.photoRejectedReason();

  /**
   * Add a photo to the strip, dropping and revoking whatever falls off the
   * end. Revoking is not optional bookkeeping: each preview holds a decoded
   * full-resolution frame alive, and a long call is a lot of shutter presses.
   */
  const pushPhoto = useCallback((photo: VoiceRoomPhoto) => {
    setPhotos((current) => {
      const next = [...current, photo];
      while (next.length > VISIBLE_PHOTOS) {
        URL.revokeObjectURL(next.shift()!.previewUrl);
      }
      return next;
    });
  }, []);

  const setPhotoStatus = useCallback(
    (id: number, status: VoiceRoomPhotoStatus) => {
      setPhotos((current) =>
        current.map((photo) =>
          photo.id === id ? { ...photo, status } : photo,
        ),
      );
    },
    [],
  );

  // Release every preview on unmount. The room unmounts on minimize and on the
  // end of the call, so this is the common path, not the edge case.
  useEffect(
    () => () => {
      setPhotos((current) => {
        for (const photo of current) {
          URL.revokeObjectURL(photo.previewUrl);
        }
        return [];
      });
    },
    [],
  );

  // A rejection arrives after the client already believed the photo sent, so
  // the strip has to be retracted rather than never shown. The newest sent
  // photo is the one it refers to: rejections are per-frame and the daemon
  // answers them in order.
  useEffect(() => {
    if (photoRejectedSeq === 0) {
      return;
    }
    setPhotos((current) => {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (current[index]!.status === "sent") {
          const next = [...current];
          next[index] = { ...next[index]!, status: "failed" };
          return next;
        }
      }
      return current;
    });
    setSendError(photoRejectedReason === "failed" ? "store-failed" : "refused");
    // Keyed on the counter alone: the reason is read at the moment a rejection
    // lands, and re-running when only the reason changes would re-fire for a
    // rejection already reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoRejectedSeq]);

  const shutter = useCallback(async () => {
    if (!assistantId || sending) {
      return;
    }
    // The photo belongs to the session that is live at the press. Everything
    // below can outlive that session, so delivery is pinned to it here.
    const sessionGeneration = useLiveVoiceStore.getState().sessionGeneration;
    setSendError(null);
    setSending(true);
    let photoId: number | null = null;
    try {
      const frame = await camera.captureFrame();
      if (!frame) {
        setSendError("capture-failed");
        return;
      }

      // The thumbnail appears as soon as there are bytes, before the upload
      // resolves. The press has to acknowledge itself immediately: a shutter
      // that shows nothing until a round trip completes reads as a dead
      // button, which is what sends people pressing it again.
      photoId = nextPhotoId.current++;
      pushPhoto({
        id: photoId,
        previewUrl: URL.createObjectURL(frame),
        status: "sending",
      });

      // The same preparation a pasted or dragged image gets. A viewfinder
      // frame is normally already under the auto-resize threshold, so this is
      // usually a pass-through. It is here so the one path that isn't (a
      // high-resolution track on a recent phone) behaves like every other
      // attachment rather than like a special case.
      const prepared = await prepareImageAttachmentForUpload(frame);
      const file = prepared.status === "failed" ? frame : prepared.file;

      const uploaded = await uploadChatAttachment(assistantId, file);
      if (!uploaded.ok) {
        setSendError("upload-failed");
        setPhotoStatus(photoId, "failed");
        return;
      }

      // The upload succeeding is not the photo arriving. A session that is
      // mid-reconnect cannot take the id, a session that ended must not hand
      // it to whichever session runs now, and it is deliberately not queued
      // across either gap (see `attachImage`), so the one thing that must not
      // happen is this returning quietly: the shutter has already fired and
      // the user would carry on talking to an assistant that cannot see it.
      if (attachLiveVoiceImage(uploaded.id, sessionGeneration)) {
        setPhotoStatus(photoId, "sent");
      } else {
        setSendError("not-delivered");
        setPhotoStatus(photoId, "failed");
      }
    } catch (error) {
      captureError(error, {
        context: "voice-room camera: capture/upload photo",
      });
      setSendError("upload-failed");
      if (photoId !== null) {
        setPhotoStatus(photoId, "failed");
      }
    } finally {
      setSending(false);
    }
  }, [assistantId, camera, pushPhoto, sending, setPhotoStatus]);

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
  const failure = camera.error ?? sendError;

  return {
    camera,
    sending,
    photos,
    // A classification with no copy of its own (`aborted`, which nothing is
    // meant to show) still says something rather than going silent.
    errorKey: failure
      ? (CAMERA_ERROR_KEYS[failure] ?? CAMERA_ERROR_KEYS.unknown!)
      : null,
    shutter,
    open,
    close,
  };
}
