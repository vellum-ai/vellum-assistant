import { GoogleGenAI } from "@google/genai";

import type { SttTranscribeResult } from "../../stt/types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 60_000;

const TRANSCRIPTION_PROMPT =
  "Transcribe the audio exactly as spoken. Return only the transcribed text with no additional commentary, labels, or formatting.";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GoogleGeminiProviderOptions {
  /** Gemini model to use (default: "gemini-2.5-flash"). */
  model?: string;
  /** Override the Google AI API base URL (useful for proxies or on-prem). */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Google Gemini batch STT provider.
 *
 * Encodes audio as base64 inline data, sends it to the Gemini
 * `models.generateContent` endpoint with a transcription-focused prompt,
 * and returns a normalised `{ text }` result compatible with the daemon
 * batch transcription boundary.
 */
export class GoogleGeminiProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, options: GoogleGeminiProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;

    this.client = options.baseUrl
      ? new GoogleGenAI({
          apiKey,
          httpOptions: { baseUrl: options.baseUrl },
        })
      : new GoogleGenAI({ apiKey });
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<SttTranscribeResult> {
    const base64Audio = audio.toString("base64");
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Audio,
                },
              },
              { text: TRANSCRIPTION_PROMPT },
            ],
          },
        ],
        config: {
          abortSignal: effectiveSignal,
        },
      });

      const text = response.text?.trim() ?? "";
      return { text };
    } catch (error: unknown) {
      // Re-throw AbortError as-is so normalizeSttError() maps it to "timeout"
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      // Preserve status code context for normalizeSttError() category mapping.
      // The @google/genai SDK throws ApiError with a `status` property.
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);

      if (status != null) {
        throw new Error(
          `Google Gemini API error (${status}): ${message.slice(0, 300)}`,
        );
      }

      throw new Error(`Google Gemini API error: ${message.slice(0, 300)}`);
    }
  }
}
