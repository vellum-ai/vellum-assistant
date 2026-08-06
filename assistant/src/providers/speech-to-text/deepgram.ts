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
 * Deepgram nova-3's `multi` (code-switching) roster: the languages the model
 * can follow across a single utterance. A model property, separate from the
 * monolingual roster below: nova-3 transcribes many more languages one at a
 * time than it can switch between mid-utterance.
 */
export const DEEPGRAM_MULTI_LANGUAGE_CODES = [
  "en",
  "es",
  "fr",
  "de",
  "hi",
  "ru",
  "pt",
  "ja",
  "it",
  "nl",
] as const;

/**
 * The verified Deepgram nova-3 monolingual roster (base language codes only,
 * per Deepgram's models-languages-overview documentation). This is the
 * daemon's one source of truth for the curated spoken-language codes offered
 * in settings surfaces (the settings skill derives its valid set from it,
 * plus `"multi"` itself); the web catalog
 * (`clients/web/src/lib/stt/language-catalog.ts`) mirrors it and a parity
 * test pins the two together. Extending it requires verifying nova-3
 * monolingual support in Deepgram's docs first. Regional variants (e.g.
 * "en-US") stay out: `services.stt.language` accepts any non-empty string,
 * so they remain expressible as custom values.
 */
export const DEEPGRAM_NOVA3_MONOLINGUAL_CODES = [
  "ar",
  "be",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fa",
  "fi",
  "fr",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "ko",
  "lt",
  "lv",
  "mk",
  "mr",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sr",
  "sv",
  "ta",
  "te",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh",
] as const;

/**
 * Deepgram constructor options implied by a language selection, for
 * spreading into adapter constructor options. Owning the model+language
 * pairing here keeps the invariant in one place instead of at each call
 * site (the batch adapter and the realtime resolver spread this the same
 * way).
 *
 * - Unset returns `{}`: the adapter passes no `language` param, which
 *   Deepgram decodes as English (NOT auto-detection), and the caller's
 *   default model stays in effect.
 * - Any configured language pins `model: "nova-3"` alongside it. The
 *   rosters above are verified against nova-3 (and `"multi"` is a
 *   nova-3-only feature); the adapters' default nova-2 supports only a
 *   subset of them, so one uniform rule keeps every explicitly configured
 *   language on the model the roster is verified for.
 */
export function deepgramLanguageOptions(language: string | undefined): {
  model?: string;
  language?: string;
} {
  if (!language) {
    return {};
  }
  return { model: "nova-3", language };
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
