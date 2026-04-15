// Default ElevenLabs voice — "Amelia" (expressive, enthusiastic, British English).
// Used by both in-app TTS and phone calls (via Twilio ConversationRelay).
// Mirrored in: clients/macos/.../OpenAIVoiceService.swift (defaultVoiceId)
export const DEFAULT_ELEVENLABS_VOICE_ID = "ZF6FPAbjXT4488VcRRnw";

/** Valid conversation timeout values (seconds). Shared with voice-config-update tool. */
export const VALID_CONVERSATION_TIMEOUTS = [5, 10, 15, 30, 60] as const;
