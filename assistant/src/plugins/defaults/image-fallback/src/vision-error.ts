/**
 * Detection for the vision-not-supported recovery path.
 *
 * The provider layer normalizes every raw "model can't take image input"
 * rejection (OpenRouter's "no endpoints found that support image input",
 * vLLM-style "this model does not support vision", etc.) into one stable
 * `ProviderError` message: "This model (X) doesn't support image input.
 * Remove the image or switch to a vision-capable model." The recovery hook
 * keys on that normalized message rather than the raw provider phrasings, so
 * the provider layer stays the single place that understands upstream error
 * shapes.
 */

const VISION_NOT_SUPPORTED_ERROR_PATTERN = /doesn't support image input/i;

/** Whether an error message indicates a vision-not-supported rejection. */
export function isVisionNotSupportedError(message: string): boolean {
  return VISION_NOT_SUPPORTED_ERROR_PATTERN.test(message);
}
