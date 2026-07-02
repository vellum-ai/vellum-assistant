/**
 * Concise pointer/status messages posted to the initiating conversation
 * so the user sees call lifecycle events without the full transcript
 * (which lives in the dedicated voice conversation).
 *
 * Trust-aware: trusted audiences get pointer messages routed through the
 * daemon conversation as a conversation turn (the assistant generates the text).
 * Untrusted/unknown audiences always receive deterministic fallback text
 * written directly to the conversation store.
 */

import { runPointerMessageTurn } from "../daemon/pointer-turn-runner.js";
import {
  addMessage,
  getConversationOriginChannel,
  getConversationRecentProvenanceTrustClass,
} from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";
import {
  buildPointerInstruction,
  type CallPointerMessageContext,
  getPointerFallbackMessage,
} from "./call-pointer-message-composer.js";

const log = getLogger("call-pointer-messages");

type PointerEvent =
  | "started"
  | "completed"
  | "failed"
  | "verification_succeeded"
  | "verification_failed";

type PointerAudienceMode = "auto" | "trusted" | "untrusted";

// ---------------------------------------------------------------------------
// Trust resolution
// ---------------------------------------------------------------------------

/**
 * Resolve whether the audience for a pointer message is trusted.
 *
 * Trusted when:
 * - recent message provenance trust class is 'guardian', 'trusted_contact',
 *   or 'unverified_contact'
 * - conversation origin channel is 'vellum' (desktop app)
 *
 * Untrusted by default when insufficient evidence.
 */
function resolvePointerAudienceTrust(conversationId: string): boolean {
  try {
    // Check provenance trust class on recent messages first — this catches
    // identity-known non-guardian contacts (trusted and unverified) who
    // initiate calls from gateway channels (e.g. WhatsApp) where the
    // conversation itself isn't desktop-origin.
    const provenance =
      getConversationRecentProvenanceTrustClass(conversationId);
    if (
      provenance === "guardian" ||
      provenance === "trusted_contact" ||
      provenance === "unverified_contact"
    )
      return true;

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

  if (trustedAudience) {
    // Route through the daemon conversation — the assistant generates the
    // pointer text as a natural conversation turn, shaped by context,
    // identity, and preferences.
    const instruction = buildPointerInstruction(context);
    try {
      await runPointerMessageTurn(conversationId, instruction, requiredFacts);
      return;
    } catch (err) {
      log.warn(
        { err, event, conversationId },
        "Daemon pointer processing failed, falling back to deterministic",
      );
    }
  } else {
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
  // desktop conversation list as a channel-bound conversation.
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
