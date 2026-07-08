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
