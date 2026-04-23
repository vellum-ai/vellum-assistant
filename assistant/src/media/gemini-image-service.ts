import { ApiError, GoogleGenAI } from "@google/genai";

import {
  type GeneratedImage,
  type ImageGenCredentials,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ManagedProxyCredentials,
  MAX_VARIANTS,
} from "./types.js";

// --- Constants ---

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const ALLOWED_MODELS = new Set([
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
]);

// --- Error mapping ---

export function mapGeminiError(error: unknown): string {
  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 400) {
      return "The image request was invalid. Please check your prompt and try again.";
    }
    if (status === 401 || status === 403) {
      return "Authentication failed. Please check your Gemini API key.";
    }
    if (status === 429) {
      return "Rate limit exceeded. Please wait a moment and try again.";
    }
    if (status !== undefined && status >= 500) {
      return "The Gemini service is temporarily unavailable. Please try again later.";
    }
    return `Gemini API error (status ${status}). Please try again.`;
  }
  if (error instanceof Error) {
    return `Image generation failed: ${error.message}`;
  }
  return "An unexpected error occurred during image generation.";
}

// --- Managed proxy direct HTTP call ---

/**
 * Call the managed proxy directly via fetch, using the Gemini API URL format.
 * The platform proxy translates this to Vertex AI internally with ADC auth.
 *
 * Uses the Gemini API format:
 *   POST {baseUrl}/v1beta/models/{model}:generateContent
 */
async function generateImageViaProxy(
  credentials: ManagedProxyCredentials,
  model: string,
  contents: unknown[],
  config: Record<string, unknown>,
): Promise<{
  images: GeneratedImage[];
  text?: string;
}> {
  const url = `${credentials.baseUrl}/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.assistantApiKey}`,
    },
    body: JSON.stringify({
      contents,
      generationConfig: config,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Managed proxy request failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: { mimeType?: string; data?: string };
        }>;
      };
    }>;
  };

  const images: GeneratedImage[] = [];
  let text: string | undefined;

  const responseParts = data.candidates?.[0]?.content?.parts;
  if (responseParts) {
    for (const part of responseParts) {
      if (part.inlineData) {
        images.push({
          mimeType: part.inlineData.mimeType ?? "image/png",
          dataBase64: part.inlineData.data ?? "",
        });
      }
      if (part.text) {
        text = text ? `${text}\n${part.text}` : part.text;
      }
    }
  }

  return { images, text };
}

// --- Core function ---

export async function generateImage(
  credentials: ImageGenCredentials,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const model =
    request.model && ALLOWED_MODELS.has(request.model)
      ? request.model
      : DEFAULT_MODEL;

  const variants = Math.max(1, Math.min(request.variants ?? 1, MAX_VARIANTS));

  // Build contents array — append a title request so the model's text
  // response contains a short filename-safe title for the generated image.
  const promptWithTitle = `${request.prompt}\n\nAlso respond with a short title (max 6 words) for the image on its own line, prefixed with "Title: ".`;
  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [{ text: promptWithTitle }];

  if (request.mode === "edit" && request.sourceImages) {
    for (const img of request.sourceImages) {
      parts.push({
        inlineData: { mimeType: img.mimeType, data: img.dataBase64 },
      });
    }
  }

  const config = { responseModalities: ["TEXT", "IMAGE"] as string[] };
  const contents = [{ role: "user" as const, parts }];

  // For the managed proxy, bypass the @google/genai SDK and make direct HTTP
  // calls. The SDK's generateContent doesn't support responseModalities for
  // image generation. Direct fetch lets us use the Gemini API format with
  // the managed proxy translating to Vertex internally.
  if (credentials.type === "managed-proxy") {
    const makeSingleCall = () =>
      generateImageViaProxy(credentials, model, contents, config);

    if (variants === 1) {
      const result = await makeSingleCall();
      const title = extractTitle(result.text);
      if (title) {
        for (const img of result.images) img.title = title;
      }
      return {
        images: result.images,
        text: stripTitleLine(result.text),
        resolvedModel: model,
      };
    }

    const results = await Promise.all(
      Array.from({ length: variants }, () => makeSingleCall()),
    );
    const allImages: GeneratedImage[] = [];
    let combinedText: string | undefined;
    for (const result of results) {
      const title = extractTitle(result.text);
      if (title) {
        for (const img of result.images) img.title = title;
      }
      allImages.push(...result.images);
      if (result.text) {
        combinedText = combinedText
          ? `${combinedText}\n${result.text}`
          : result.text;
      }
    }
    return {
      images: allImages,
      text: stripTitleLine(combinedText),
      resolvedModel: model,
    };
  }

  // Direct Gemini API path — use the SDK with API key auth.
  const client = new GoogleGenAI({ apiKey: credentials.apiKey });

  const makeSingleCall = async () => {
    const response = await client.models.generateContent({
      model,
      contents,
      config,
    });

    const images: GeneratedImage[] = [];
    let text: string | undefined;

    const responseParts = response.candidates?.[0]?.content?.parts;
    if (responseParts) {
      for (const part of responseParts) {
        if (part.inlineData) {
          images.push({
            mimeType: part.inlineData.mimeType ?? "image/png",
            dataBase64: part.inlineData.data ?? "",
          });
        }
        if (part.text) {
          text = text ? `${text}\n${part.text}` : part.text;
        }
      }
    }

    const title = extractTitle(text);
    if (title) {
      for (const img of images) {
        img.title = title;
      }
    }

    return { images, text: stripTitleLine(text), title };
  };

  if (variants === 1) {
    const result = await makeSingleCall();
    return { ...result, resolvedModel: model };
  }

  const results = await Promise.all(
    Array.from({ length: variants }, () => makeSingleCall()),
  );

  const allImages: GeneratedImage[] = [];
  let combinedText: string | undefined;

  for (const result of results) {
    allImages.push(...result.images);
    if (result.text) {
      combinedText = combinedText
        ? `${combinedText}\n${result.text}`
        : result.text;
    }
  }

  return { images: allImages, text: combinedText, resolvedModel: model };
}

// --- Title extraction helpers ---

const TITLE_RE = /^Title:\s*(.+)/im;

/**
 * Extract a title from the model's text response.
 * Looks for a line starting with "Title: " and sanitizes it for use as a filename.
 */
function extractTitle(text?: string): string | undefined {
  if (!text) return undefined;
  const match = TITLE_RE.exec(text);
  if (!match?.[1]) return undefined;
  return match[1]
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
}

/**
 * Remove the "Title: ..." line from text so it doesn't appear in
 * the tool result content shown to the user.
 */
function stripTitleLine(text?: string): string | undefined {
  if (!text) return undefined;
  const stripped = text
    .replace(TITLE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}
