/**
 * Static provider catalog data for TTS, STT, email, and image generation.
 *
 * Each catalog is a readonly array of provider descriptors used by the
 * corresponding settings card to populate dropdowns, display credential
 * guides, and gate feature availability.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ProviderCredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TTSProvider {
  id: string;
  displayName: string;
  subtitle: string;
  supportsVoiceSelection: boolean;
  apiKeyPlaceholder: string;
  credentialsGuide: ProviderCredentialsGuide;
}

export const TTS_PROVIDERS: readonly TTSProvider[] = [
  {
    id: "elevenlabs",
    displayName: "ElevenLabs",
    subtitle:
      "High-quality voice synthesis for conversations and read-aloud. Requires an ElevenLabs API key.",
    supportsVoiceSelection: true,
    apiKeyPlaceholder: "sk_…",
    credentialsGuide: {
      description:
        "Sign in to ElevenLabs, go to your Profile, and copy your API key.",
      url: "https://elevenlabs.io/app/settings/api-keys",
      linkLabel: "Open ElevenLabs API Keys",
    },
  },
  {
    id: "fish-audio",
    displayName: "Fish Audio",
    subtitle:
      "Natural-sounding voice synthesis with custom voice cloning. Requires a Fish Audio API key and voice reference ID.",
    supportsVoiceSelection: true,
    apiKeyPlaceholder: "Enter your Fish Audio API key",
    credentialsGuide: {
      description:
        "Sign in to Fish Audio, navigate to API Keys in your dashboard, and create a new key.",
      url: "https://fish.audio/app/api-keys/",
      linkLabel: "Open Fish Audio API Keys",
    },
  },
  {
    id: "deepgram",
    displayName: "Deepgram",
    subtitle:
      "Fast, accurate text-to-speech synthesis. Uses the same API key as Deepgram speech-to-text.",
    supportsVoiceSelection: false,
    apiKeyPlaceholder: "Enter your Deepgram API key",
    credentialsGuide: {
      description:
        "Sign in to Deepgram, navigate to your API Keys page, and create or copy an existing key. This is the same key used for speech-to-text.",
      url: "https://console.deepgram.com/",
      linkLabel: "Open Deepgram Console",
    },
  },
  {
    id: "xai",
    displayName: "xAI",
    subtitle:
      "Text-to-speech from xAI with expressive voices (eve, ara, rex, sal, leo). Requires an xAI API key.",
    supportsVoiceSelection: false,
    apiKeyPlaceholder: "Enter your xAI API key",
    credentialsGuide: {
      description:
        "Sign in to the xAI console, navigate to API Keys, and create a new key.",
      url: "https://console.x.ai/",
      linkLabel: "Open xAI Console",
    },
  },
];

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

export interface STTProvider {
  id: string;
  displayName: string;
  subtitle: string;
  /**
   * Only offered when the renderer can reach the mac helper's
   * `SFSpeechRecognizer` (the macOS Electron shell) — see
   * `isNativeDictationSupported()` in `@/runtime/native-dictation-partials`.
   */
  requiresNativeDictation?: boolean;
  /**
   * Prerequisite the user must complete before the provider works. Shown
   * below the provider dropdown in place of a credentials guide.
   */
  setupWarning?: string;
  /** Absent for keyless providers (on-device recognition needs no API key). */
  apiKeyPlaceholder?: string;
  credentialsGuide?: ProviderCredentialsGuide;
}

/**
 * STT provider id for Apple's on-device recognition. Not a daemon provider:
 * when selected, dictation routes through the mac helper's recognizer and
 * never calls `/v1/stt/transcribe`. Duplicated as a literal in
 * `@/domains/chat/voice/stt-api.ts` (`prefersMacosNativeStt`) — cross-domain
 * constants stay duplicated there, like the `LS_STT_*` keys.
 */
export const MACOS_NATIVE_STT_PROVIDER_ID = "macos-native";

export const STT_PROVIDERS: readonly STTProvider[] = [
  {
    id: "deepgram",
    displayName: "Deepgram",
    subtitle:
      "Fast, accurate speech-to-text transcription. Uses the same API key as Deepgram text-to-speech.",
    apiKeyPlaceholder: "Enter your Deepgram API key",
    credentialsGuide: {
      description:
        "Sign in to Deepgram, navigate to your API Keys page, and create or copy an existing key. This is the same key used for text-to-speech.",
      url: "https://console.deepgram.com/",
      linkLabel: "Open Deepgram Console",
    },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    subtitle: "OpenAI Whisper transcription. Requires an OpenAI API key.",
    apiKeyPlaceholder: "sk-…",
    credentialsGuide: {
      description:
        "Sign in to the OpenAI platform, navigate to API Keys, and create a new secret key.",
      url: "https://platform.openai.com/api-keys",
      linkLabel: "Open OpenAI API Keys",
    },
  },
  {
    id: MACOS_NATIVE_STT_PROVIDER_ID,
    displayName: "macOS Native Dictation",
    subtitle:
      "Apple's on-device speech recognition, running locally through the macOS helper. Works offline and needs no API key.",
    requiresNativeDictation: true,
    setupWarning:
      "Requires macOS Dictation to be turned on: open System Settings → Keyboard, then enable Dictation. macOS downloads the on-device speech model the first time Dictation is enabled — without it, voice input produces no transcript.",
  },
];

// ---------------------------------------------------------------------------
// Email BYO
// ---------------------------------------------------------------------------

export interface EmailByoProvider {
  id: "mailgun" | "resend";
  displayName: string;
  setupSkill: string;
  docsUrl: string;
}

export const EMAIL_BYO_PROVIDERS: readonly EmailByoProvider[] = [
  {
    id: "mailgun",
    displayName: "Mailgun",
    setupSkill: "mailgun-setup",
    docsUrl: "https://www.mailgun.com/",
  },
  {
    id: "resend",
    displayName: "Resend",
    setupSkill: "resend-setup",
    docsUrl: "https://resend.com/",
  },
];

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

export const AVAILABLE_IMAGE_GEN_MODELS = [
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
  "gpt-image-2",
] as const;

export const IMAGE_GEN_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gemini-3.1-flash-image-preview": "Nano Banana 2",
  "gemini-3-pro-image-preview": "Nano Banana Pro",
  "gpt-image-2": "GPT Image 2",
};

/**
 * Image-generation provider for a model id, by prefix. Mirrors the daemon's
 * `providerForImageModelPrefix` / `providerForModel` (`assistant/src/media/`):
 * `gpt-*` / `dall-e-*` → openai, `gemini-*` → gemini, otherwise gemini.
 */
export function providerForImageGenModel(modelId: string): "openai" | "gemini" {
  if (modelId.startsWith("gpt-") || modelId.startsWith("dall-e-")) {
    return "openai";
  }
  if (modelId.startsWith("gemini-")) {
    return "gemini";
  }
  return "gemini";
}
