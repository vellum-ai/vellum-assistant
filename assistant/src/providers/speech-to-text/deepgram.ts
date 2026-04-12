import type { SttTranscribeResult } from "../../stt/types.js";

const DEFAULT_BASE_URL = "https://api.deepgram.com";
const DEFAULT_MODEL = "nova-2";
const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeepgramProviderOptions {
  /** Deepgram model to use (default: "nova-2"). */
  model?: string;
  /** BCP-47 language code (e.g. "en", "es"). Omitted by default (auto-detect). */
  language?: string;
  /** Enable Deepgram smart formatting (punctuation, numerals, etc.). Default: true. */
  smartFormatting?: boolean;
  /** Override the Deepgram API base URL (useful for proxies or on-prem). */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Deepgram prerecorded-audio STT provider.
 *
 * Posts raw audio bytes to Deepgram's `/v1/listen` endpoint and returns
 * a normalised `{ text }` result compatible with the daemon batch
 * transcription boundary.
 */
export class DeepgramProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string | undefined;
  private readonly smartFormatting: boolean;
  private readonly baseUrl: string;

  constructor(apiKey: string, options: DeepgramProviderOptions = {}) {
    this.apiKey = apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.language = options.language;
    this.smartFormatting = options.smartFormatting ?? true;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<SttTranscribeResult> {
    const url = this.buildRequestUrl();
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": mimeType,
      },
      body: audio,
      signal: effectiveSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Deepgram API error (${response.status}): ${body.slice(0, 300)}`,
      );
    }

    const result = (await response.json()) as DeepgramResponse;
    const transcript =
      result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

    return { text: typeof transcript === "string" ? transcript.trim() : "" };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildRequestUrl(): string {
    const params = new URLSearchParams();
    params.set("model", this.model);
    if (this.language) {
      params.set("language", this.language);
    }
    if (this.smartFormatting) {
      params.set("smart_format", "true");
    }
    return `${this.baseUrl}/v1/listen?${params.toString()}`;
  }
}

// ---------------------------------------------------------------------------
// Response shape (subset relevant to transcript extraction)
// ---------------------------------------------------------------------------

interface DeepgramAlternative {
  transcript?: string;
}

interface DeepgramChannel {
  alternatives?: DeepgramAlternative[];
}

interface DeepgramResults {
  channels?: DeepgramChannel[];
}

interface DeepgramResponse {
  results?: DeepgramResults;
}
