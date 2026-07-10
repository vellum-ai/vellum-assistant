/**
 * Detection for the image-input recovery path.
 *
 * Anthropic returns a 400 with one of these messages when an image block
 * violates a hard limit. The too-large patterns match the per-side pixel cap
 * ("image dimensions exceed max allowed size") and the base64 payload cap
 * ("image exceeds 5 MB maximum: 7465044 bytes > 5242880 bytes"). The
 * unprocessable patterns match "Could not process image" (images below the
 * provider's undocumented minimum size, and payloads the provider cannot
 * decode) and "image does not match the provided media type" (bytes whose
 * format disagrees with the declared `media_type`, e.g. an HTML page stored as
 * image/png). Distinct classification matters because retrying with the same
 * image is futile — the recovery path must resize, relabel, or note it instead.
 *
 * Exported as the single source of truth: the image-recovery hook reads these
 * to recognize the rejections it can recover, and `daemon/conversation-error`
 * imports them so the user-facing classification stays in lockstep with what
 * the hook actually recovers.
 */

export const IMAGE_DIMENSIONS_TOO_LARGE_PATTERNS: readonly RegExp[] = [
  /image dimensions? exceeds? max allowed size/i,
  /image exceeds \d+\s*MB maximum/i,
];

export const IMAGE_UNPROCESSABLE_PATTERNS: readonly RegExp[] = [
  /could not process image/i,
  /image does not match the provided media type/i,
];

/** Whether an error message indicates an image-input dimension/payload failure. */
export function isImageDimensionsTooLargeError(message: string): boolean {
  return IMAGE_DIMENSIONS_TOO_LARGE_PATTERNS.some((p) => p.test(message));
}

/**
 * Whether an error message indicates the provider could not process an image at
 * all — an image below the minimum size floor, undecodable bytes, or bytes
 * whose format does not match the declared media type.
 */
export function isImageUnprocessableError(message: string): boolean {
  return IMAGE_UNPROCESSABLE_PATTERNS.some((p) => p.test(message));
}

/** Any image-input rejection the recovery hook knows how to act on. */
export function isRecoverableImageError(message: string): boolean {
  return (
    isImageDimensionsTooLargeError(message) ||
    isImageUnprocessableError(message)
  );
}
