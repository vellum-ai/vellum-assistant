/**
 * Shared copy + toggle definitions for the two-toggle voice "transcription
 * preferences" UI.
 *
 * Both the Voice settings page (`domains/settings/pages/voice-page.tsx`) and
 * the voice first-run card (`domains/chat/voice/voice-room/`) render the same
 * pair of transcript-visibility toggles bound to the same `voice-prefs` store.
 * The user-facing strings and the store-field mapping are single-sourced here
 * so the two surfaces can't drift.
 */

/** Fields on `useVoicePrefsStore` that the transcript toggles read/write. */
export type VoiceTranscriptPrefKey =
  | "showUserTranscript"
  | "showAssistantTranscript";

export interface VoiceTranscriptToggleDef {
  /** Store field this toggle reads/writes on `useVoicePrefsStore`. */
  prefKey: VoiceTranscriptPrefKey;
  /** Toggle label; also the toggle's accessible name. */
  label: string;
  /** One-line description shown beneath the label (settings surface). */
  description: string;
}

export const VOICE_TRANSCRIPT_TOGGLES: readonly VoiceTranscriptToggleDef[] = [
  {
    prefKey: "showUserTranscript",
    label: "Show the words you say",
    description: "Live transcription while you speak.",
  },
  {
    prefKey: "showAssistantTranscript",
    label: "Show the words the assistant says",
    description: "Text alongside the spoken response.",
  },
];

/** Closing nudge shown under both surfaces' toggle rows. */
export const VOICE_TRANSCRIPT_RECOMMENDATION =
  "We recommend keeping both off to start. It feels more like a real conversation.";
