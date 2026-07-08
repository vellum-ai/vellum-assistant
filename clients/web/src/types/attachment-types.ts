import type { AttachmentsByIdGetResponse } from "@/generated/daemon/types.gen";

/**
 * Server-canonical attachment metadata, sourced from the daemon's generated
 * attachment schema — the single source of truth for these field names/types.
 * Do not re-declare `id`/`filename`/`mimeType`/`sizeBytes` by hand; if a field
 * is wrong or missing, fix the route `responseBody` schema and regenerate.
 */
export type AttachmentMetadata = Pick<
  AttachmentsByIdGetResponse,
  "id" | "filename" | "mimeType" | "sizeBytes"
>;

/** Display metadata for a file attachment (user-uploaded or assistant-generated),
 *  used to render the chip inside a message bubble. For live sessions, populated
 *  from SSE event data via `toDisplayAttachments` (`utils/display-attachments.ts`). For
 *  history reload, populated from the daemon's structured attachment metadata
 *  (real UUIDs that resolve against the content endpoint) or, as a fallback,
 *  reverse-parsed from `[File attachment] …` summary lines in the message text. */
export interface DisplayAttachment extends AttachmentMetadata {
  /** Client-only URL for the attachment's actual content — either an inline
   *  data URI (when the daemon sent `data`) or a blob URL lazily fetched from
   *  the daemon's content endpoint. When null, the preview modal fetches from
   *  the daemon. Must NOT be a thumbnail — see `thumbnailUrl`.
   *
   *  For video attachments, this is always null: the daemon may send inline
   *  data for small videos, but the Electron CSP `media-src` directive
   *  allows `blob:` not `data:`, so a `data:video/…` URI would be
   *  CSP-blocked. Setting it null forces the preview modal's lazy-fetch
   *  path, which retrieves the bytes as a CSP-safe blob URL. */
  previewUrl: string | null;
  /** Client-only URL for a JPEG thumbnail (from daemon `thumbnailData`),
   *  used as a poster image for video attachments. Null/undefined when no
   *  thumbnail is available. Distinct from `previewUrl` so the preview modal
   *  can fetch the real video bytes while still showing a poster frame. */
  thumbnailUrl?: string | null;
}

/**
 * Derive `previewUrl` and `thumbnailUrl` from the inline data fields the
 * daemon sends. Shared by both attachment mappers
 * (`runtimeAttachmentsToDisplay` for history reload, `toDisplayAttachments`
 * for live streaming) so the derivation logic lives in one place.
 *
 * - `previewUrl` gets a data URI from `data` for non-video types only.
 *   Videos are excluded because the Electron CSP `media-src 'self' blob:`
 *   directive does not allow `data:` URIs — so a small inline video would
 *   be CSP-blocked. Instead, `previewUrl` stays null for all videos,
 *   forcing the preview modal's lazy-fetch to retrieve a CSP-safe blob URL.
 * - `thumbnailUrl` gets a data URI from `thumbnailData` (always a JPEG).
 *   This is used as the `<video poster>` attribute and as the chip
 *   background image, never as the video source itself.
 */
export function deriveDisplayUrls(
  mimeType: string,
  data: string | undefined,
  thumbnailData: string | undefined,
): { previewUrl: string | null; thumbnailUrl: string | null } {
  const isVideo = mimeType.toLowerCase().startsWith("video/");
  const previewUrl =
    data && !isVideo ? `data:${mimeType};base64,${data}` : null;
  const thumbnailUrl = thumbnailData
    ? `data:image/jpeg;base64,${thumbnailData}`
    : null;
  return { previewUrl, thumbnailUrl };
}
