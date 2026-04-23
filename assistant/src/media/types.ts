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
