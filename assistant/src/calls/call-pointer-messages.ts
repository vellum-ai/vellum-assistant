/**
 * Concise pointer/status messages posted to the initiating conversation
 * so the user sees call lifecycle events without the full transcript
 * (which lives in the dedicated voice conversation).
 *
 * Trust-aware: trusted audiences receive assistant-generated copy when a
 * generator is available; untrusted/unknown audiences always receive
 * deterministic fallback text.
 */

import * as conversationStore from '../memory/conversation-store.js';
import { getLogger } from '../util/logger.js';
import type { PointerCopyGenerator } from '../runtime/http-types.js';
import {
  composeCallPointerMessageGenerative,
  getPointerFallbackMessage,
  type CallPointerMessageContext,
} from './call-pointer-message-composer.js';

const log = getLogger('call-pointer-messages');

export type PointerEvent = 'started' | 'completed' | 'failed' | 'guardian_verification_succeeded' | 'guardian_verification_failed';

export type PointerAudienceMode = 'auto' | 'trusted' | 'untrusted';

// ---------------------------------------------------------------------------
// Module-level generator injection (set by daemon lifecycle at startup)
// ---------------------------------------------------------------------------

let pointerCopyGenerator: PointerCopyGenerator | undefined;

/**
 * Inject the daemon-provided pointer copy generator.
 * Called from daemon/lifecycle.ts at startup, following the same pattern
 * as setRelayBroadcast.
 */
export function setPointerCopyGenerator(generator: PointerCopyGenerator): void {
  pointerCopyGenerator = generator;
}

/** @internal Reset for tests. */
export function resetPointerCopyGenerator(): void {
  pointerCopyGenerator = undefined;
}

// ---------------------------------------------------------------------------
// Trust resolution
// ---------------------------------------------------------------------------

/**
 * Resolve whether the audience for a pointer message is trusted.
 *
 * Trusted when:
 * - conversation threadType is 'private' (local desktop-origin context)
 * - conversation origin channel is 'vellum' (desktop app)
 *
 * Untrusted by default when insufficient evidence.
 */
function resolvePointerAudienceTrust(conversationId: string): boolean {
  try {
    const threadType = conversationStore.getConversationThreadType(conversationId);
    if (threadType === 'private') return true;

    const originChannel = conversationStore.getConversationOriginChannel(conversationId);
    if (originChannel === 'vellum') return true;
  } catch {
    // Conversation may not exist or DB may be unavailable — default untrusted.
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function addPointerMessage(
  conversationId: string,
  event: PointerEvent,
  phoneNumber: string,
  extra?: { duration?: string; reason?: string; verificationCode?: string; channel?: string },
  audienceMode: PointerAudienceMode = 'auto',
): Promise<void> {
  const context: CallPointerMessageContext = {
    scenario: event,
    phoneNumber,
    duration: extra?.duration,
    reason: extra?.reason,
    verificationCode: extra?.verificationCode,
    channel: extra?.channel,
  };

  // Build required-facts list so generated text cannot drop key details.
  const requiredFacts: string[] = [phoneNumber];
  if (extra?.duration) requiredFacts.push(extra.duration);
  if (extra?.verificationCode) requiredFacts.push(extra.verificationCode);
  if (extra?.reason) requiredFacts.push(extra.reason);

  // Enforce lifecycle outcome keywords so the LLM cannot rewrite e.g. a
  // "failed" event as a success — the generated text must contain the
  // outcome word verbatim.
  const eventOutcomeKeywords: Record<PointerEvent, string | undefined> = {
    started: 'started',
    completed: 'completed',
    failed: 'failed',
    guardian_verification_succeeded: 'succeeded',
    guardian_verification_failed: 'failed',
  };
  const outcomeKeyword = eventOutcomeKeywords[event];
  if (outcomeKeyword) requiredFacts.push(outcomeKeyword);

  let text: string;

  const isTrusted =
    audienceMode === 'trusted' ||
    (audienceMode === 'auto' && resolvePointerAudienceTrust(conversationId));

  if (isTrusted && pointerCopyGenerator) {
    text = await composeCallPointerMessageGenerative(context, { requiredFacts }, pointerCopyGenerator);
  } else {
    if (!isTrusted && pointerCopyGenerator) {
      log.debug({ event, conversationId }, 'Untrusted audience — using deterministic pointer copy');
    }
    text = getPointerFallbackMessage(context);
  }

  // Pointer messages are assistant-generated status updates in the initiating
  // desktop thread. Do not set userMessageChannel — doing so would mark the
  // conversation's origin channel as voice, causing it to leak into the
  // desktop thread list as a channel-bound session.
  await conversationStore.addMessage(
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
