/**
 * Convert backend attachment wire types into display-ready objects.
 *
 * Pure function — no side effects. Used by the streaming message
 * updater to produce `DisplayAttachment` objects for chat bubbles.
 */

import type { AssistantOutboundAttachment } from "@vellumai/assistant-api";
import type { DisplayAttachment } from "@/types/attachment-types";
import { deriveDisplayUrls } from "@/utils/attachment-urls";

/**
 * Convert `AssistantOutboundAttachment` objects into `DisplayAttachment`
 * objects suitable for rendering in chat message bubbles. URL derivation
 * (previewUrl vs thumbnailUrl) is shared with the history-reload path via
 * {@link deriveDisplayUrls} — see that function for the rationale on why
 * videos always get a null previewUrl (Electron CSP).
 */
export function toDisplayAttachments(
  attachments: AssistantOutboundAttachment[] | undefined,
): DisplayAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att) => {
    const { previewUrl, thumbnailUrl } = deriveDisplayUrls(
      att.mimeType,
      att.data,
      att.thumbnailData,
    );
    return {
      id: att.id ?? att.filename,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes:
        att.sizeBytes ?? (att.data ? Math.floor((att.data.length * 3) / 4) : 0),
      previewUrl,
      thumbnailUrl,
    };
  });
}
