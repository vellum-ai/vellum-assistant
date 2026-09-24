/**
 * localStorage keys for AI settings.
 *
 * Centralized here so keys are discoverable and consistent. Each card
 * reads/writes via `getLocalSetting` / `setLocalSetting` using these
 * constants as the key argument.
 */

export const LS_IMAGE_GEN_PROVIDER = "vellum:ai:imageGenProvider";
export const LS_IMAGE_GEN_MODEL = "vellum:ai:imageGenModel";
export const LS_WEB_SEARCH_PROVIDER = "vellum:ai:webSearchProvider";
export const LS_WEB_FETCH_PROVIDER = "vellum:ai:webFetchProvider";
export const LS_EMAIL_MODE = "vellum:ai:emailMode";
export const LS_EMAIL_BYO_PROVIDER = "vellum:ai:emailByoProvider";
/**
 * "1" once the user has dismissed the Assistant Inbox rail entry from its
 * upgrade-required state. Only honoured while the org lacks managed email:
 * the entry returns the moment there is an inbox to open.
 */
export const LS_ASSISTANT_INBOX_HIDDEN = "vellum:ui:assistantInboxHidden";
/**
 * Prefix, completed with the assistant id: a JSON array of message ids the
 * user deleted from that assistant's inbox on this device. The platform keeps
 * no delete for a single message, so the inbox hides them here instead.
 */
export const LS_ASSISTANT_INBOX_DELETED_EMAILS_PREFIX =
  "vellum:ui:assistantInboxDeletedEmails:";

export const LS_TTS_PROVIDER = "vellum:voice:ttsProvider";
export const LS_TTS_API_KEY_PREFIX = "vellum:voice:ttsApiKey:";
export const LS_TTS_VOICE_ID_PREFIX = "vellum:voice:ttsVoiceId:";
export const LS_STT_PROVIDER = "vellum:voice:sttProvider";
export const LS_STT_API_KEY_PREFIX = "vellum:voice:sttApiKey:";
