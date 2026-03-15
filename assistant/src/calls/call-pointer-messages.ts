/**
 * Concise pointer/status messages posted to the initiating conversation
 * so the user sees call lifecycle events without the full transcript
 * (which lives in the dedicated voice conversation).
 *
 * Trust-aware: trusted audiences get pointer messages routed through the
 * daemon session as a conversation turn (the assistant generates the text).
 * Untrusted/unknown audiences always receive deterministic fallback text
 * written directly to the conversation store.
 */

import {
  addMessage,
  getConversationOriginChannel,
  getConversationRecentProvenanceTrustClass,
  getConversationType,
} from "../memory/conversation-crud.js";
import { getLogger } from "../util/logger.js";
import {
  buildPointerInstruction,
  type CallPointerMessageContext,
  getPointerFallbackMessage,
} from "./call-pointer-message-composer.js";

const log = getLogger("call-pointer-messages");

export type PointerEvent =
  | "started"
  | "completed"
  | "failed"
  | "verification_succeeded"
  | "verification_failed";

export type PointerAudienceMode = "auto" | "trusted" | "untrusted";

/**
 * Daemon-injected function that sends a message through the daemon session
 * pipeline (persistAndProcessMessage), letting the assistant generate the
 * pointer text as a natural conversation turn.
 *
 * @param requiredFacts - facts that must appear verbatim in the generated
 *   text (phone number, duration, outcome keyword, etc.). The processor
 *   should validate the output and throw if any are missing so the
 *   deterministic fallback fires.
 */
export type PointerMessageProcessor = (
  conversationId: string,
  instruction: string,
  requiredFacts?: string[],
) => Promise<void>;

// ---------------------------------------------------------------------------
// Module-level processor injection (set by daemon lifecycle at startup)
// ---------------------------------------------------------------------------

let pointerMessageProcessor: PointerMessageProcessor | undefined;

/**
 * Inject the daemon-provided pointer message processor.
 * Called from daemon/lifecycle.ts at startup, following the same pattern
 * as setRelayBroadcast.
 */
export function setPointerMessageProcessor(
  processor: PointerMessageProcessor,
): void {
  pointerMessageProcessor = processor;
}

/** @internal Reset for tests. */
export function resetPointerMessageProcessor(): void {
  pointerMessageProcessor = undefined;
}

// ---------------------------------------------------------------------------
// Trust resolution
// ---------------------------------------------------------------------------

/**
 * Resolve whether the audience for a pointer message is trusted.
 *
 * Trusted when:
 * - recent message provenance trust class is 'guardian' or 'trusted_contact'
 * - conversation conversationType is 'private' (local desktop-origin context)
 * - conversation origin channel is 'vellum' (desktop app)
 *
 * Untrusted by default when insufficient evidence.
 */
function resolvePointerAudienceTrust(conversationId: string): boolean {
  try {
    // Check provenance trust class on recent messages first — this catches
    // trusted contacts who initiate calls from gateway channels (e.g. WhatsApp)
    // where the conversation itself isn't a desktop-origin private conversation.
    const provenance =
      getConversationRecentProvenanceTrustClass(conversationId);
    if (provenance === "guardian" || provenance === "trusted_contact")
      return true;

    const conversationType = getConversationType(conversationId);
    if (conversationType === "private") return true;

    const originChannel = getConversationOriginChannel(conversationId);
    if (originChannel === "vellum") return true;
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
  extra?: {
    duration?: string;
    reason?: string;
    verificationCode?: string;
    channel?: string;
  },
  audienceMode: PointerAudienceMode = "auto",
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
  // These are passed to the processor for post-generation validation.
  const requiredFacts: string[] = [phoneNumber];
  if (extra?.duration) requiredFacts.push(extra.duration);
  if (extra?.verificationCode) requiredFacts.push(extra.verificationCode);
  if (extra?.reason) requiredFacts.push(extra.reason);

  // Enforce lifecycle outcome keywords so the LLM cannot rewrite e.g. a
  // "failed" event as a success — the generated text must contain the
  // outcome word verbatim.
  const eventOutcomeKeywords: Record<PointerEvent, string | undefined> = {
    started: "started",
    completed: "completed",
    failed: "failed",
    verification_succeeded: "succeeded",
    verification_failed: "failed",
  };
  const outcomeKeyword = eventOutcomeKeywords[event];
  if (outcomeKeyword) requiredFacts.push(outcomeKeyword);

  const trustedAudience =
    audienceMode === "trusted" ||
    (audienceMode === "auto" && resolvePointerAudienceTrust(conversationId));

  if (trustedAudience && pointerMessageProcessor) {
    // Route through the daemon session — the assistant generates the
    // pointer text as a natural conversation turn, shaped by context,
    // identity, and preferences.
    const instruction = buildPointerInstruction(context);
    try {
      await pointerMessageProcessor(conversationId, instruction, requiredFacts);
      return;
    } catch (err) {
      log.warn(
        { err, event, conversationId },
        "Daemon pointer processing failed, falling back to deterministic",
      );
    }
  } else if (!trustedAudience && pointerMessageProcessor) {
    log.debug(
      { event, conversationId },
      "Untrusted audience — using deterministic pointer copy",
    );
  }

  // Deterministic fallback: write directly to the conversation store.
  // Used for untrusted audiences, when the daemon processor is unavailable,
  // or when daemon processing fails.
  const text = getPointerFallbackMessage(context);

  // Pointer messages are assistant-generated status updates in the initiating
  // desktop conversation. Do not set userMessageChannel — doing so would mark the
  // conversation's origin channel as voice, causing it to leak into the
  // desktop conversation list as a channel-bound session.
  await addMessage(
    conversationId,
    "assistant",
    JSON.stringify([{ type: "text", text }]),
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
