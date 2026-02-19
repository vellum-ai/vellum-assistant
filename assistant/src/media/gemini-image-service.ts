import { GoogleGenAI, ApiError } from '@google/genai';

// --- Request / Response types ---

export interface ImageGenerationRequest {
  prompt: string;
  mode: 'generate' | 'edit';
  /** Base64-encoded source images for edit mode */
  sourceImages?: Array<{ mimeType: string; dataBase64: string }>;
  /** Model override; defaults to 'gemini-2.5-flash-image' */
  model?: string;
  /** Number of output variants (1-4, default 1) */
  variants?: number;
}

export interface GeneratedImage {
  mimeType: string;
  dataBase64: string;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  text?: string;
  resolvedModel: string;
}

// --- Constants ---

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const ALLOWED_MODELS = new Set(['gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3-pro-image-preview']);
const MAX_VARIANTS = 4;

// --- Error mapping ---

export function mapGeminiError(error: unknown): string {
  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 400) {
      return 'The image request was invalid. Please check your prompt and try again.';
    }
    if (status === 401 || status === 403) {
      return 'Authentication failed. Please check your Gemini API key.';
    }
    if (status === 429) {
      return 'Rate limit exceeded. Please wait a moment and try again.';
    }
    if (status !== undefined && status >= 500) {
      return 'The Gemini service is temporarily unavailable. Please try again later.';
    }
    return `Gemini API error (status ${status}). Please try again.`;
  }
  if (error instanceof Error) {
    return `Image generation failed: ${error.message}`;
  }
  return 'An unexpected error occurred during image generation.';
}

// --- Core function ---

export async function generateImage(
  apiKey: string,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const model = request.model && ALLOWED_MODELS.has(request.model)
    ? request.model
    : DEFAULT_MODEL;

  const variants = Math.max(1, Math.min(request.variants ?? 1, MAX_VARIANTS));

  const client = new GoogleGenAI({ apiKey });

  // Build contents array
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: request.prompt },
  ];

  if (request.mode === 'edit' && request.sourceImages) {
    for (const img of request.sourceImages) {
      parts.push({
        inlineData: { mimeType: img.mimeType, data: img.dataBase64 },
      });
    }
  }

  const config = { responseModalities: ['TEXT', 'IMAGE'] as string[] };

  const makeSingleCall = async () => {
    const response = await client.models.generateContent({
      model,
      contents: [{ role: 'user' as const, parts }],
      config,
    });

    const images: GeneratedImage[] = [];
    let text: string | undefined;

    const responseParts = response.candidates?.[0]?.content?.parts;
    if (responseParts) {
      for (const part of responseParts) {
        if (part.inlineData) {
          images.push({
            mimeType: part.inlineData.mimeType ?? 'image/png',
            dataBase64: part.inlineData.data ?? '',
          });
        }
        if (part.text) {
          text = text ? `${text}\n${part.text}` : part.text;
        }
      }
    }

    return { images, text };
  };

  if (variants === 1) {
    const result = await makeSingleCall();
    return { ...result, resolvedModel: model };
  }

  // Parallel calls for multiple variants
  const results = await Promise.all(
    Array.from({ length: variants }, () => makeSingleCall()),
  );

  const allImages: GeneratedImage[] = [];
  let combinedText: string | undefined;

  for (const result of results) {
    allImages.push(...result.images);
    if (result.text) {
      combinedText = combinedText ? `${combinedText}\n${result.text}` : result.text;
    }
  }

  return { images: allImages, text: combinedText, resolvedModel: model };
}
