/**
 * Derive `previewUrl` and `thumbnailUrl` from the inline data fields the
 * daemon sends. Shared by both attachment mappers
 * (`runtimeAttachmentsToDisplay` for history reload, `toDisplayAttachments`
 * for live streaming) so the derivation logic lives in one place.
 *
 * - `previewUrl` gets a data URI from `data` for non-video types. Videos
 *   are excluded when a storage id exists (see `hasResolvableId`) because
 *   the Electron CSP `media-src 'self' blob:` directive does not allow
 *   `data:` URIs — forcing `previewUrl` null makes the preview modal
 *   lazy-fetch a CSP-safe blob URL. However, when no storage id exists
 *   (in-memory drafts with no stored row), the lazy-fetch has nothing to
 *   fetch, so the inline data is kept as the only playable source.
 * - `thumbnailUrl` gets a data URI from `thumbnailData` (always a JPEG).
 *   This is used as the `<video poster>` attribute and as the chip
 *   background image, never as the video source itself.
 *
 * @param hasResolvableId Whether the attachment has a storage id that the
 *   daemon's `/v1/attachments/:id/content` endpoint can resolve. When
 *   false, inline video data is kept as `previewUrl` since there's no
 *   stored content to lazy-fetch.
 */
export function deriveDisplayUrls(
  mimeType: string,
  data: string | undefined,
  thumbnailData: string | undefined,
  hasResolvableId: boolean,
): { previewUrl: string | null; thumbnailUrl: string | null } {
  const isVideo = mimeType.toLowerCase().startsWith("video/");
  // For videos with a storage id, force null so the modal lazy-fetches a
  // CSP-safe blob URL. For videos without one (in-memory drafts), keep the
  // inline data — it's the only playable source.
  const useInlineVideoData = isVideo && !hasResolvableId;
  const previewUrl =
    data && (!isVideo || useInlineVideoData)
      ? `data:${mimeType};base64,${data}`
      : null;
  const thumbnailUrl = thumbnailData
    ? `data:image/jpeg;base64,${thumbnailData}`
    : null;
  return { previewUrl, thumbnailUrl };
}
