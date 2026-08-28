/**
 * The seam between the Eyes camera and the composer's send: takes the frame the
 * gate is holding, puts it through the same resize and upload path a picked
 * photo takes, and hands back an attachment the message can carry.
 *
 * Best effort by design. The user asked to send a message, not to send a photo,
 * so every failure here resolves to `null` and the send goes without the frame.
 */

import { uploadChatAttachment } from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import { useSightStore } from "@/domains/chat/sight/sight-store";
import { captureError } from "@/lib/sentry/capture-error";
import type { DisplayAttachment } from "@/types/attachment-types";

/** Where a failure is filed, so the tag reads the same from every path. */
const ERROR_CONTEXT = "sight-frame-attachment";

/**
 * Upload the camera's current frame, or `null` when there is nothing to send:
 * the camera is off, no assistant is resolved, nothing has been captured yet,
 * or the upload failed.
 */
export async function uploadSightFrameAttachment(
  assistantId: string | null,
): Promise<DisplayAttachment | null> {
  if (!assistantId || useSightStore.getState().status !== "on") {
    return null;
  }

  try {
    const frame = await useSightStore.getState().takeSendFrame();
    if (!frame) {
      return null;
    }

    // A camera frame is a JPEG the attachment pipeline may still want to shrink,
    // and a preparation that fails is not a reason to drop the frame: the
    // original uploads instead, exactly as the picker path does.
    const prepared = await prepareImageAttachmentForUpload(frame);
    const file = prepared.status === "failed" ? frame : prepared.file;

    const result = await uploadChatAttachment(assistantId, file);
    if (!result.ok) {
      captureError(new Error(result.error.detail), {
        context: ERROR_CONTEXT,
        bestEffort: true,
      });
      return null;
    }

    return {
      id: result.id,
      filename: result.filename ?? file.name,
      mimeType: result.mimeType ?? file.type,
      sizeBytes: result.sizeBytes ?? file.size,
      // No blob URL: nothing on this path owns one to revoke, so the sent
      // bubble fetches the stored bytes through the daemon like any other
      // attachment the composer did not queue.
      previewUrl: null,
      thumbnailUrl: null,
    };
  } catch (cause) {
    captureError(cause, { context: ERROR_CONTEXT, bestEffort: true });
    return null;
  }
}
