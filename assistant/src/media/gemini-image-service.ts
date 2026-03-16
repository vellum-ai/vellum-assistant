import { ApiError, GoogleGenAI } from "@google/genai";

// --- Request / Response types ---

interface ImageGenerationRequest {
  prompt: string;
  mode: "generate" | "edit";
  /** Base64-encoded source images for edit mode */
  sourceImages?: Array<{ mimeType: string; dataBase64: string }>;
  /** Model override; defaults to 'gemini-3.1-flash-image-preview' */
  model?: string;
  /** Number of output variants (1-4, default 1) */
  variants?: number;
}

/** Credentials for direct Gemini API access. */
interface DirectCredentials {
  type: "direct";
  apiKey: string;
}

/** Credentials for managed proxy access via Vertex AI. */
interface ManagedProxyCredentials {
  type: "managed-proxy";
  assistantApiKey: string;
  baseUrl: string;
}

export type ImageGenCredentials = DirectCredentials | ManagedProxyCredentials;

interface GeneratedImage {
  mimeType: string;
  dataBase64: string;
  /** Short title derived from the model's text response, if available. */
  title?: string;
}

interface ImageGenerationResult {
  images: GeneratedImage[];
  text?: string;
  resolvedModel: string;
}

// --- Constants ---

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const ALLOWED_MODELS = new Set([
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
]);
const MAX_VARIANTS = 4;

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

  const client =
    credentials.type === "managed-proxy"
      ? new GoogleGenAI({
          vertexai: true,
          project: "proxy",
          location: "global",
          httpOptions: {
            baseUrl: credentials.baseUrl,
            headers: { Authorization: `Bearer ${credentials.assistantApiKey}` },
          },
        })
      : new GoogleGenAI({ apiKey: credentials.apiKey });

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

  const makeSingleCall = async () => {
    const response = await client.models.generateContent({
      model,
      contents: [{ role: "user" as const, parts }],
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

    // Extract title from the text response and apply to images
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

  // Parallel calls for multiple variants
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
