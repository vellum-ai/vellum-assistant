import type { DisplayAttachment } from "@/types/attachment-types";
import { deriveDisplayUrls } from "@/utils/attachment-urls";
import type { ConversationMessageAttachment } from "@vellumai/assistant-api";

/**
 * Convert daemon-provided structured attachment metadata into DisplayAttachment
 * objects. These carry real daemon-assigned UUIDs that resolve against the
 * `/v1/attachments/:id/content` endpoint, unlike the `rehydrated:N` stubs
 * produced by text-parsing.
 *
 * Shared by `history.ts` (initial page load) and `reconcile.ts` (periodic
 * server sync) so attachment mapping logic stays in one place. URL derivation
 * is shared with the streaming path via {@link deriveDisplayUrls}.
 */
export function runtimeAttachmentsToDisplay(
  runtimeAttachments: ConversationMessageAttachment[],
): DisplayAttachment[] {
  return runtimeAttachments.map((a) => {
    const { previewUrl, thumbnailUrl } = deriveDisplayUrls(
      a.mimeType,
      a.data,
      a.thumbnailData,
      true,
    );
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
