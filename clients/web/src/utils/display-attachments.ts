/**
 * Convert backend attachment wire types into display-ready objects.
 *
 * Pure function — no side effects. Used by the streaming message
 * updater to produce `DisplayAttachment` objects for chat bubbles.
 */

import type { AssistantOutboundAttachment } from "@vellumai/assistant-api";
import type { DisplayAttachment } from "@/types/attachment-types";

/**
 * Convert `AssistantOutboundAttachment` objects into `DisplayAttachment`
 * objects suitable for rendering in chat message bubbles. When inline base64
 * data is available, a data-URI `previewUrl` is created for all MIME types so
 * the preview modal can render or download the content without a separate fetch.
 * When only a thumbnail is available (e.g. video with omitted data), the
 * thumbnail is used as a fallback preview. Files with `fileBacked: true` and no
 * inline data rely on the daemon's `/v1/attachments/:id/content` endpoint —
 * the modal fetches content lazily via the assistantId-scoped proxy URL.
 */
export function toDisplayAttachments(
  attachments: AssistantOutboundAttachment[] | undefined,
): DisplayAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att) => {
    let previewUrl: string | null = null;
    if (att.data) {
      previewUrl = `data:${att.mimeType};base64,${att.data}`;
    } else if (att.thumbnailData) {
      previewUrl = `data:image/jpeg;base64,${att.thumbnailData}`;
    }
    return {
      id: att.id ?? att.filename,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes:
        att.sizeBytes ?? (att.data ? Math.floor((att.data.length * 3) / 4) : 0),
      previewUrl,
    };
  });
}
