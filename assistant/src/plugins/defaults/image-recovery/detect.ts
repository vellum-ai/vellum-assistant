/**
 * Detection for the image-too-large recovery path.
 *
 * Anthropic returns a 400 with one of these messages when an image block
 * violates a hard limit. The first matches the per-side pixel cap ("image
 * dimensions exceed max allowed size"); the second matches the base64 payload
 * cap ("image exceeds 5 MB maximum: 7465044 bytes > 5242880 bytes"). Distinct
 * classification matters because retrying with the same oversized image is
 * futile — the recovery path must downscale or note it instead.
 *
 * Exported as the single source of truth: the image-recovery `stop` hook reads
 * it to recognize the rejection it can recover, and `daemon/conversation-error`
 * imports it so the user-facing classification stays in lockstep with what the
 * hook actually recovers.
 */

export const IMAGE_DIMENSIONS_TOO_LARGE_PATTERNS: readonly RegExp[] = [
  /image dimensions? exceeds? max allowed size/i,
  /image exceeds \d+\s*MB maximum/i,
];

/** Whether an error message indicates an image-input dimension/payload failure. */
export function isImageDimensionsTooLargeError(message: string): boolean {
  return IMAGE_DIMENSIONS_TOO_LARGE_PATTERNS.some((p) => p.test(message));
}
