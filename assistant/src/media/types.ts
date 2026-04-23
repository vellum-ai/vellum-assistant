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
 * Canonical mapping shared between the runtime model setter
 * (`setImageGenModel`) and workspace migration 006-services-config so the
 * two cannot drift. Unknown models fall through to "gemini".
 */
export function providerForImageModelPrefix(model: string): ImageGenProvider {
  if (model.startsWith("gpt") || model.startsWith("dall-e")) {
    return "openai";
  }
  return "gemini";
}
