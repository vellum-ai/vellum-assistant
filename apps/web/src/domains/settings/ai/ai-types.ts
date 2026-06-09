import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";

// ---------------------------------------------------------------------------
// Profile status
// ---------------------------------------------------------------------------

export type ProfileStatus = "active" | "disabled";

// ---------------------------------------------------------------------------
// Provider constants
// ---------------------------------------------------------------------------

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

// ---------------------------------------------------------------------------
// Call-site override draft
// ---------------------------------------------------------------------------

export interface CallSiteOverrideDraft {
  profile?: string | null;
  provider?: string | null;
  model?: string | null;
}

// ---------------------------------------------------------------------------
// Service mode
// ---------------------------------------------------------------------------

export type ServiceMode = "managed" | "your-own";

// ---------------------------------------------------------------------------
// Daemon config types (mirrors the assistant daemon schema)
// ---------------------------------------------------------------------------

export interface ProfileEntry {
  source?: "managed" | "user";
  status?: ProfileStatus;
  label?: string | null;
  description?: string | null;
  provider?: string | null;
  /**
   * Name of a `provider_connections` row to bind this profile to. When set,
   * the daemon dispatcher resolves auth from this specific connection
   * instead of falling back to "the first active connection for the
   * provider." Mirrors `ProfileEntry.provider_connection` in
   * `assistant/src/config/schemas/llm.ts`. Snake_case wire shape matches
   * the daemon's Zod schema; do not rename without also touching the
   * daemon route handlers.
   */
  provider_connection?: string | null;
  model?: string | null;
  maxTokens?: number;
  effort?: string;
  speed?: string;
  verbosity?: string;
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean; level?: string };
  contextWindow?: { maxInputTokens?: number };
}

export type ProfileWithName = { name: string } & ProfileEntry;

/**
 * Body for the dedicated profile replace endpoint
 * (`PUT /v1/config/llm/profiles/:name`, operation
 * `config_llm_profiles_replace`) when editing a managed profile.
 *
 * Built-in profiles are code-defined on the daemon; only the user-policy
 * leaves (display label, enabled status) may be edited. The daemon persists
 * them as sparse `llm.profileOverrides` entries. `null` is a clear
 * sentinel; an absent key leaves the stored override untouched.
 */
export type ProfileOverridePatch = Pick<ProfileEntry, "label" | "status">;

export interface DaemonConfig {
  services?: {
    "web-search"?: { mode?: string; provider?: string };
    "image-generation"?: { mode?: string };
  };
  llm?: {
    default?: { provider?: string; model?: string };
    activeProfile?: string;
    profileOrder?: string[];
    profiles?: Record<string, ProfileEntry>;
    callSites?: Record<string, CallSiteOverrideDraft | null | undefined>;
  };
}

/**
 * Typed body for daemon config PATCH requests.
 *
 * The daemon uses deep-merge semantics: omitted keys are left unchanged,
 * `null` values delete the key. This type mirrors `DaemonConfig` but makes
 * every level partial and allows `null` at record-entry positions where
 * deletion is meaningful (individual profiles, individual call-site overrides).
 *
 * Catches typos like `{ llm: { activeProfiIe: "..." } }` at compile time
 * instead of silently sending malformed patches.
 */
export type DaemonConfigPatch = {
  services?: {
    "web-search"?: { mode?: string; provider?: string } | null;
    "image-generation"?: { mode?: string } | null;
  };
  llm?: {
    default?: { provider?: string; model?: string } | null;
    activeProfile?: string | null;
    profileOrder?: string[];
    profiles?: Record<string, Partial<ProfileEntry> | null>;
    callSites?: Record<string, CallSiteOverrideDraft | null>;
  };
};

export interface InferenceTokenBudgetState {
  maxOutputTokens: number;
  maxOutputTouched: boolean;
  contextWindowTokens: number;
  contextWindowTouched: boolean;
}

// ---------------------------------------------------------------------------
// Provider catalog types
// ---------------------------------------------------------------------------

export interface ProviderCredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

export interface TTSProvider {
  id: string;
  displayName: string;
  subtitle: string;
  supportsVoiceSelection: boolean;
  apiKeyPlaceholder: string;
  credentialsGuide: ProviderCredentialsGuide;
}

export interface STTProvider {
  id: string;
  displayName: string;
  subtitle: string;
  apiKeyPlaceholder: string;
  credentialsGuide: ProviderCredentialsGuide;
}

export interface EmailByoProvider {
  id: "mailgun" | "resend";
  displayName: string;
  setupSkill: string;
  docsUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AVAILABLE_IMAGE_GEN_MODELS = [
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
] as const;

export const IMAGE_GEN_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gemini-3.1-flash-image-preview": "Nano Banana 2",
  "gemini-3-pro-image-preview": "Nano Banana Pro",
};

/**
 * Providers that have entries in the LLM model catalog and can be used in
 * call-site overrides. Keep this list in sync with MODELS_BY_PROVIDER in
 * llm-model-catalog.ts.
 */
export const INFERENCE_PROVIDERS = [
  "anthropic",
  "openai",
  "fireworks",
  "openrouter",
  "gemini",
] as const;

export const INFERENCE_PROVIDER_DISPLAY_NAMES = PROVIDER_DISPLAY_NAMES;

export const TOKEN_SLIDER_MIN_TOKENS = 1_000;
export const TOKEN_SLIDER_STEP_TOKENS = 1_000;
export const DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS = 200_000;

// ---------------------------------------------------------------------------
// TTS / STT provider catalogs
// ---------------------------------------------------------------------------

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
];

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
// Local-storage keys
// ---------------------------------------------------------------------------

export const LS_IMAGE_GEN_MODE = "vellum:ai:imageGenMode";
export const LS_IMAGE_GEN_MODEL = "vellum:ai:imageGenModel";
export const LS_WEB_SEARCH_MODE = "vellum:ai:webSearchMode";
export const LS_WEB_SEARCH_PROVIDER = "vellum:ai:webSearchProvider";
export const LS_EMAIL_MODE = "vellum:ai:emailMode";
export const LS_EMAIL_BYO_PROVIDER = "vellum:ai:emailByoProvider";

export const LS_TTS_PROVIDER = "vellum:voice:ttsProvider";
export const LS_TTS_API_KEY_PREFIX = "vellum:voice:ttsApiKey:";
export const LS_TTS_VOICE_ID_PREFIX = "vellum:voice:ttsVoiceId:";
export const LS_STT_PROVIDER = "vellum:voice:sttProvider";
export const LS_STT_API_KEY_PREFIX = "vellum:voice:sttApiKey:";


