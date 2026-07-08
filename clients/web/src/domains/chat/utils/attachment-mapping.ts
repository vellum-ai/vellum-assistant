import type { DisplayAttachment } from "@/types/attachment-types";
import type { ConversationMessageAttachment } from "@vellumai/assistant-api";

/**
 * Convert daemon-provided structured attachment metadata into DisplayAttachment
 * objects. These carry real daemon-assigned UUIDs that resolve against the
 * `/v1/attachments/:id/content` endpoint, unlike the `rehydrated:N` stubs
 * produced by text-parsing.
 *
 * Shared by `history.ts` (initial page load) and `reconcile.ts` (periodic
 * server sync) so attachment mapping logic stays in one place.
 */
export function runtimeAttachmentsToDisplay(
  runtimeAttachments: ConversationMessageAttachment[],
): DisplayAttachment[] {
  return runtimeAttachments.map((a) => {
    // previewUrl carries the actual attachment content (inline data URI or
    // null to trigger lazy fetch). thumbnailUrl carries a JPEG poster frame
    // (from thumbnailData) — must NOT be used as previewUrl, or the preview
    // modal will try to play a JPEG in a <video> element and skip the lazy
    // fetch that retrieves the real video bytes.
    let previewUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    if (a.data) {
      previewUrl = `data:${a.mimeType};base64,${a.data}`;
    }
    if (a.thumbnailData) {
      thumbnailUrl = `data:image/jpeg;base64,${a.thumbnailData}`;
    }
    return {
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      previewUrl,
      thumbnailUrl,
    };
  });
}
