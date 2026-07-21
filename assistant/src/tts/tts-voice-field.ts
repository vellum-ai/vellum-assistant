/**
 * Where each TTS provider stores its "voice" selection under
 * `services.tts.providers.<id>`.
 *
 * A voice change (the `voice_config_update` tool's `tts_voice_id` setting and
 * the `assistant tts voice` CLI command) must write to the entry for the
 * *active* provider — a managed (vellum) assistant's voice is a Deepgram Aura
 * model id (or an ElevenLabs voice id, since managed speech serves both) at
 * `.vellum.model`, not an ElevenLabs voice id at `.elevenlabs.voiceId`.
 * Writing the wrong field is a silent no-op: the write "succeeds" but the
 * active provider keeps its old voice.
 *
 * Only ElevenLabs voice ids are alphanumeric; Aura model ids (and the other
 * providers' voice references) are hyphenated, so the alphanumeric validation
 * rule is ElevenLabs-only.
 */

export interface TtsVoiceField {
  /** Canonical config path the voice id/model is written to. */
  path: string;
  /** Human-facing label for tool/CLI success messages. */
  label: string;
  /** Whether the id must be alphanumeric (ElevenLabs voice-id format). */
  alphanumericOnly: boolean;
}

export const TTS_VOICE_FIELD_BY_PROVIDER: Record<string, TtsVoiceField> = {
  elevenlabs: {
    path: "services.tts.providers.elevenlabs.voiceId",
    label: "ElevenLabs voice",
    alphanumericOnly: true,
  },
  vellum: {
    path: "services.tts.providers.vellum.model",
    label: "Vellum managed voice",
    alphanumericOnly: false,
  },
  deepgram: {
    path: "services.tts.providers.deepgram.model",
    label: "Deepgram voice",
    alphanumericOnly: false,
  },
  xai: {
    path: "services.tts.providers.xai.voiceId",
    label: "xAI voice",
    alphanumericOnly: false,
  },
  "fish-audio": {
    path: "services.tts.providers.fish-audio.referenceId",
    label: "Fish Audio voice",
    alphanumericOnly: false,
  },
};

/**
 * The voice field for a provider, defaulting to ElevenLabs for any provider
 * without a dedicated voice field (its adapter validates required fields
 * itself).
 */
export function ttsVoiceFieldFor(
  providerId: string | undefined,
): TtsVoiceField {
  return (
    TTS_VOICE_FIELD_BY_PROVIDER[providerId ?? "elevenlabs"] ??
    TTS_VOICE_FIELD_BY_PROVIDER.elevenlabs
  );
}
