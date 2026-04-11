/**
 * Top-level TTS orchestration layer.
 *
 * Resolves the globally configured provider via {@link resolveTtsConfig},
 * looks up the provider adapter in the registry, and delegates synthesis.
 * Callers supply the pre-sanitized text and a use-case discriminator;
 * provider selection is always global — per-use-case policy only gates
 * capabilities (e.g. format checks), never overrides the chosen provider.
 */

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getTtsProvider } from "./provider-registry.js";
import { resolveTtsConfig } from "./tts-config-resolver.js";
import type { TtsSynthesisResult, TtsUseCase } from "./types.js";

const log = getLogger("tts:synthesize");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SynthesizeTextOptions {
  /** Pre-sanitized text to speak. */
  text: string;

  /** Product surface requesting synthesis. */
  useCase: TtsUseCase;

  /** Optional voice override (provider-specific identifier). */
  voiceId?: string;

  /** Optional abort signal. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type TtsSynthesisErrorCode =
  | "TTS_PROVIDER_NOT_CONFIGURED"
  | "TTS_SYNTHESIS_FAILED";

export class TtsSynthesisError extends Error {
  readonly code: TtsSynthesisErrorCode;

  constructor(code: TtsSynthesisErrorCode, message: string) {
    super(message);
    this.name = "TtsSynthesisError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synthesize text to audio using the globally configured TTS provider.
 *
 * 1. Resolves the active provider and its config via `tts-config-resolver`.
 * 2. Looks up the provider adapter in the registry.
 * 3. Delegates to the adapter's `synthesize` method.
 *
 * Throws {@link TtsSynthesisError} when the provider is not registered
 * or synthesis fails.
 */
export async function synthesizeText(
  options: SynthesizeTextOptions,
): Promise<TtsSynthesisResult> {
  const config = getConfig();
  const { provider: providerId } = resolveTtsConfig(config);

  let provider;
  try {
    provider = getTtsProvider(providerId);
  } catch {
    throw new TtsSynthesisError(
      "TTS_PROVIDER_NOT_CONFIGURED",
      `TTS provider "${providerId}" is not configured or not registered.`,
    );
  }

  log.info(
    {
      provider: providerId,
      useCase: options.useCase,
      textLength: options.text.length,
    },
    "Synthesizing text with TTS provider",
  );

  try {
    return await provider.synthesize({
      text: options.text,
      useCase: options.useCase,
      voiceId: options.voiceId,
      signal: options.signal,
    });
  } catch (err) {
    // Re-throw TtsSynthesisError as-is (e.g. from inner adapter errors).
    if (err instanceof TtsSynthesisError) throw err;

    throw new TtsSynthesisError(
      "TTS_SYNTHESIS_FAILED",
      `TTS synthesis failed (provider: ${providerId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
