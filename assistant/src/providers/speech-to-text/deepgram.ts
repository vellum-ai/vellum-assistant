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
  /**
   * BCP-47 language code (e.g. "en", "es"). Omitted by default, which
   * Deepgram decodes as English, NOT as auto-detection.
   */
  language?: string;
  /** Enable Deepgram smart formatting (punctuation, numerals, etc.). Default: true. */
  smartFormatting?: boolean;
  /** Override the Deepgram API base URL (useful for proxies or on-prem). */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Language-derived constructor options
// ---------------------------------------------------------------------------

/**
 * Deepgram constructor options implied by a language selection, for
 * spreading into adapter constructor options. Owning the model+language
 * pairing here keeps the invariant in one place instead of at each call
 * site (the batch adapter and the realtime resolver spread this the same
 * way).
 *
 * - Unset returns `{}`: the adapter passes no `language` param, which
 *   Deepgram decodes as English (NOT auto-detection).
 * - A normal code returns `{ language }` and keeps the caller's default
 *   model.
 * - `"multi"` (code-switching) requires nova-3: the default models of the
 *   batch and realtime adapters reject `language=multi`, so that value
 *   also pins `model: "nova-3"`.
 */
export function deepgramLanguageOptions(language: string | undefined): {
  model?: string;
  language?: string;
} {
  if (!language) {
    return {};
  }
  return language === "multi"
    ? { model: "nova-3", language: "multi" }
    : { language };
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
      body: new Uint8Array(audio),
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
