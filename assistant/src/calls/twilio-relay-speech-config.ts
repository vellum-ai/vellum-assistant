/**
 * Maps a normalized telephony STT profile into Twilio ConversationRelay
 * speech attributes.
 *
 * This module is the single place where STT profile data is serialized
 * for the Twilio ConversationRelay TwiML element. Route code should call
 * {@link buildTwilioRelaySpeechConfig} rather than composing STT attributes
 * inline.
 *
 * **Cutover note:** This module is part of the current ConversationRelay
 * production path. When the telephony STT cutover to `services.stt` is
 * activated, this module will no longer be needed — the media-stream STT
 * session resolves provider config server-side. Retain for rollback until
 * the cutover is confirmed stable.
 */

import type { TelephonySttProfile } from "./stt-profile.js";

/**
 * Twilio ConversationRelay speech-to-text attributes.
 *
 * All values are pre-formatted strings ready for direct insertion into
 * TwiML XML attribute values (XML escaping is the caller's responsibility).
 */
export interface TwilioRelaySpeechConfig {
  /** STT provider name (e.g. "Deepgram", "Google"). */
  transcriptionProvider: string;
  /** ASR model identifier, or undefined when the provider default should be used. */
  speechModel: string | undefined;
  /** Comma-separated vocabulary hints for the STT provider, or undefined when no hints are available. */
  hints: string | undefined;
  /** How aggressively the provider detects the start of caller speech. */
  interruptSensitivity: string;
}

/**
 * Build the Twilio ConversationRelay speech config from a normalized
 * STT profile and contextual call data.
 *
 * @param sttProfile - Provider-agnostic STT profile from {@link resolveTelephonySttProfile}.
 * @param interruptSensitivity - Interrupt sensitivity level from the voice quality profile.
 * @param hints - Resolved hints string from {@link resolveCallHints}, or undefined/empty.
 */
export function buildTwilioRelaySpeechConfig(
  sttProfile: TelephonySttProfile,
  interruptSensitivity: string,
  hints: string | undefined,
): TwilioRelaySpeechConfig {
  return {
    transcriptionProvider: sttProfile.provider,
    speechModel: sttProfile.speechModel,
    hints: hints && hints.length > 0 ? hints : undefined,
    interruptSensitivity,
  };
}
