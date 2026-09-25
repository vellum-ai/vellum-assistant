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
 * Prefix, completed with the assistant id: a JSON array of message ids the
 * user deleted from that assistant's inbox on this device. The platform keeps
 * no delete for a single message, so the inbox hides them here instead.
 */
export const LS_ASSISTANT_INBOX_DELETED_EMAILS_PREFIX =
  "vellum:ui:assistantInboxDeletedEmails:";
/**
 * Prefix, completed with the assistant id: a JSON array of message ids the
 * user has opened in that assistant's inbox on this device. The platform
 * keeps no read state, so the list's unread mark is this device's memory.
 */
export const LS_ASSISTANT_INBOX_READ_EMAILS_PREFIX =
  "vellum:ui:assistantInboxReadEmails:";
/**
 * Prefix, completed with the assistant id: "1" while the user has pinned
 * that assistant's Email to the side menu on this device.
 */
export const LS_ASSISTANT_INBOX_PINNED_PREFIX =
  "vellum:ui:assistantInboxPinned:";
/**
 * Prefix, completed with the assistant id: "1" while the user has closed the
 * profile's Email card on this device. Honoured only while the org's plan
 * has no managed email; the card returns once there is an inbox to open.
 */
export const LS_ASSISTANT_INBOX_CARD_DISMISSED_PREFIX =
  "vellum:ui:assistantInboxCardDismissed:";

export const LS_TTS_PROVIDER = "vellum:voice:ttsProvider";
export const LS_TTS_API_KEY_PREFIX = "vellum:voice:ttsApiKey:";
export const LS_TTS_VOICE_ID_PREFIX = "vellum:voice:ttsVoiceId:";
export const LS_STT_PROVIDER = "vellum:voice:sttProvider";
export const LS_STT_API_KEY_PREFIX = "vellum:voice:sttApiKey:";
