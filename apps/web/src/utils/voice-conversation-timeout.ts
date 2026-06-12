/**
 * Voice-conversation idle timeout preference.
 *
 * How long voice mode waits (while listening, with no speech) before
 * deactivating itself — the web counterpart of the Swift
 * `voiceConversationTimeoutSeconds` UserDefault. Written by the Voice
 * settings page; read by the voice-mode conversation loop.
 */

import { getLocalNumber } from "@/utils/local-settings";

export const LS_CONVERSATION_TIMEOUT =
  "vellum:voice:conversationTimeoutSeconds";

export const DEFAULT_CONVERSATION_TIMEOUT_SECONDS = 30;

/** Idle-listening duration (ms) after which voice mode turns itself off. */
export function getConversationTimeoutMs(): number {
  const seconds = getLocalNumber(
    LS_CONVERSATION_TIMEOUT,
    DEFAULT_CONVERSATION_TIMEOUT_SECONDS,
  );
  const effective =
    Number.isFinite(seconds) && seconds > 0
      ? seconds
      : DEFAULT_CONVERSATION_TIMEOUT_SECONDS;
  return effective * 1000;
}
