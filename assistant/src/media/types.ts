export type ImageGenProvider = "gemini" | "openai";

export interface DirectCredentials {
  type: "direct";
  apiKey: string;
}
export interface ManagedProxyCredentials {
  type: "managed-proxy";
  assistantApiKey: string;
  baseUrl: string;
}
export type ImageGenCredentials = DirectCredentials | ManagedProxyCredentials;

export interface ImageGenerationRequest {
  prompt: string;
  mode: "generate" | "edit";
  sourceImages?: Array<{ mimeType: string; dataBase64: string }>;
  model?: string;
  variants?: number;
}

export interface GeneratedImage {
  mimeType: string;
  dataBase64: string;
  title?: string;
}
export interface ImageGenerationResult {
  images: GeneratedImage[];
  text?: string;
  resolvedModel: string;
}

export const MAX_VARIANTS = 4;

/**
 * Derive the image-generation provider from a model identifier by prefix.
 * Shared with the runtime dispatcher `providerForModel` in
 * `image-service.ts`; prefixes must stay in sync with that function.
 * Unknown models fall through to "gemini".
 */
export function providerForImageModelPrefix(model: string): ImageGenProvider {
  if (model.startsWith("gpt-") || model.startsWith("dall-e-")) {
    return "openai";
  }
  return "gemini";
}

/**
 * Message fragments that indicate a provider billing / insufficient-credits
 * failure. Used by the per-provider error mappers to detect a non-retryable
 * out-of-credits condition that no number of retries will resolve.
 */
const BILLING_MESSAGE_PATTERNS: readonly RegExp[] = [
  /credit balance is too low/i,
  /insufficient[\s_-]*credits?/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
  /out of credits/i,
  /requires more credits/i,
  /billing/i,
  /request failed \(402\)/i,
];

/**
 * Detect a provider billing / insufficient-credits failure from an HTTP status
 * and/or error message. A 402 status is billing by definition; otherwise the
 * message is matched against known billing phrasings (OpenAI's
 * `insufficient_quota` is reported as a 429, so status alone is insufficient).
 *
 * Billing failures are non-retryable: the user must add funds or update the API
 * key. Callers surface a distinct message instead of a generic "try again".
 */
export function isImageProviderBillingError(args: {
  status?: number;
  message?: string;
}): boolean {
  if (args.status === 402) return true;
  const message = args.message ?? "";
  return BILLING_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}
