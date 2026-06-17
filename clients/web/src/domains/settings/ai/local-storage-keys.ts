/**
 * localStorage keys for AI settings.
 *
 * Centralized here so keys are discoverable and consistent. Each card
 * reads/writes via `getLocalSetting` / `setLocalSetting` using these
 * constants as the key argument.
 */

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
