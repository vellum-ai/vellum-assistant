/**
 * Concise pointer/status messages posted to the initiating conversation
 * so the user sees call lifecycle events without the full transcript
 * (which lives in the dedicated voice conversation).
 */

import * as conversationStore from '../memory/conversation-store.js';

export type PointerEvent = 'started' | 'completed' | 'failed' | 'guardian_verification_succeeded' | 'guardian_verification_failed';

export function addPointerMessage(
  conversationId: string,
  event: PointerEvent,
  phoneNumber: string,
  extra?: { duration?: string; reason?: string; verificationCode?: string },
): void {
  let text: string;
  switch (event) {
    case 'started':
      text = extra?.verificationCode
        ? `\u{1F4DE} Call to ${phoneNumber} started. Verification code: ${extra.verificationCode}`
        : `\u{1F4DE} Call to ${phoneNumber} started.`;
      break;
    case 'completed':
      text = extra?.duration
        ? `\u{1F4DE} Call to ${phoneNumber} completed (${extra.duration}).`
        : `\u{1F4DE} Call to ${phoneNumber} completed.`;
      break;
    case 'failed':
      text = extra?.reason
        ? `\u{1F4DE} Call to ${phoneNumber} failed: ${extra.reason}.`
        : `\u{1F4DE} Call to ${phoneNumber} failed.`;
      break;
    case 'guardian_verification_succeeded':
      text = `\u{2705} Guardian verification for ${phoneNumber} succeeded.`;
      break;
    case 'guardian_verification_failed':
      text = extra?.reason
        ? `\u{274C} Guardian verification for ${phoneNumber} failed: ${extra.reason}.`
        : `\u{274C} Guardian verification for ${phoneNumber} failed.`;
      break;
  }

  // Pointer messages are assistant-generated status updates in the initiating
  // desktop thread. Do not set userMessageChannel — doing so would mark the
  // conversation's origin channel as voice, causing it to leak into the
  // desktop thread list as a channel-bound session.
  conversationStore.addMessage(
    conversationId,
    'assistant',
    JSON.stringify([{ type: 'text', text }]),
  );
}

/**
 * Format a duration in milliseconds into a human-friendly string.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
