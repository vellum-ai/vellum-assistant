import { describe, expect, test } from "bun:test";

import {
  TTS_VOICE_FIELD_BY_PROVIDER,
  ttsVoiceFieldFor,
} from "../tts-voice-field.js";
import { TTS_PROVIDER_IDS } from "../types.js";

describe("ttsVoiceFieldFor", () => {
  test("maps each provider to its own voice field under services.tts.providers.<id>", () => {
    expect(ttsVoiceFieldFor("elevenlabs").path).toBe(
      "services.tts.providers.elevenlabs.voiceId",
    );
    expect(ttsVoiceFieldFor("vellum").path).toBe(
      "services.tts.providers.vellum.model",
    );
    expect(ttsVoiceFieldFor("deepgram").path).toBe(
      "services.tts.providers.deepgram.model",
    );
  });

  test("only ElevenLabs enforces the alphanumeric id format", () => {
    expect(ttsVoiceFieldFor("elevenlabs").alphanumericOnly).toBe(true);
    expect(ttsVoiceFieldFor("vellum").alphanumericOnly).toBe(false);
    expect(ttsVoiceFieldFor("deepgram").alphanumericOnly).toBe(false);
  });

  test("defaults to ElevenLabs for undefined or unknown providers", () => {
    expect(ttsVoiceFieldFor(undefined).path).toBe(
      "services.tts.providers.elevenlabs.voiceId",
    );
    expect(ttsVoiceFieldFor("nonexistent").path).toBe(
      "services.tts.providers.elevenlabs.voiceId",
    );
  });

  test("every catalog provider has a voice-field mapping", () => {
    for (const id of TTS_PROVIDER_IDS) {
      expect(TTS_VOICE_FIELD_BY_PROVIDER[id]).toBeDefined();
      expect(TTS_VOICE_FIELD_BY_PROVIDER[id].path).toContain(
        `services.tts.providers.${id}.`,
      );
    }
  });
});
