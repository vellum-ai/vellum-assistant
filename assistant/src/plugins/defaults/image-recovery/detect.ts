/**
 * Detection for the image-input recovery path.
 *
 * Anthropic returns a 400 with one of these messages when an image block
 * violates a hard limit. The too-large patterns match the per-side pixel cap
 * ("image dimensions exceed max allowed size") and the base64 payload cap
 * ("image exceeds 5 MB maximum: 7465044 bytes > 5242880 bytes"). The
 * unprocessable pattern matches "Could not process image", which Anthropic
 * returns for images below its (undocumented) minimum size and for payloads
 * it cannot decode. The mismatch pattern matches "Image does not match the
 * provided media type image/png", returned when the declared media type
 * disagrees with the actual bytes (e.g. a JPEG renamed to `.png`). Distinct
 * classification matters because retrying with the same image is futile — the
 * recovery path must resize, relabel, or note it instead.
 *
 * OpenAI-compatible providers reject the same class of input in their own
 * wording ("The image data you provided does not represent a valid image.
 * Please check your input and try again with one of the supported image
 * formats: [image/jpeg, image/png, image/gif, image/webp]"), so the
 * unsupported-format patterns carry that shape. Without them an OpenAI-family
 * 400 falls through to the generic provider-error copy and takes the whole
 * turn down with no hint that an attachment is what broke it.
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
];

export const IMAGE_MEDIA_TYPE_MISMATCH_PATTERNS: readonly RegExp[] = [
  /image does not match the provided media type/i,
];

export const IMAGE_UNSUPPORTED_FORMAT_PATTERNS: readonly RegExp[] = [
  /does not represent a valid image/i,
  /supported image formats?:/i,
];

/** Whether an error message indicates an image-input dimension/payload failure. */
export function isImageDimensionsTooLargeError(message: string): boolean {
  return IMAGE_DIMENSIONS_TOO_LARGE_PATTERNS.some((p) => p.test(message));
}

/**
 * Whether an error message indicates the provider could not process an image
 * at all — an image below the minimum size floor, or undecodable bytes.
 */
export function isImageUnprocessableError(message: string): boolean {
  return IMAGE_UNPROCESSABLE_PATTERNS.some((p) => p.test(message));
}

/**
 * Whether an error message indicates the declared media type disagrees with
 * the image's actual bytes.
 */
export function isImageMediaTypeMismatchError(message: string): boolean {
  return IMAGE_MEDIA_TYPE_MISMATCH_PATTERNS.some((p) => p.test(message));
}

/**
 * Whether an error message indicates the image's bytes are not in a format the
 * provider accepts at all, rather than merely mislabeled: an unsupported
 * codec (HEIC, AVIF, BMP), or a truncated or corrupt payload.
 */
export function isImageUnsupportedFormatError(message: string): boolean {
  return IMAGE_UNSUPPORTED_FORMAT_PATTERNS.some((p) => p.test(message));
}

/** Any image-input rejection the recovery hook knows how to act on. */
export function isRecoverableImageError(message: string): boolean {
  return (
    isImageDimensionsTooLargeError(message) ||
    isImageUnprocessableError(message) ||
    isImageMediaTypeMismatchError(message) ||
    isImageUnsupportedFormatError(message)
  );
}
