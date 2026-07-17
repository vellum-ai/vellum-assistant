/**
 * Refusal-quarantine helpers.
 *
 * When the provider's safety classifier zeroes a response (`stopReason ===
 * "refusal"`), the empty-response plugin's `post-model-call` hook rewrites that
 * turn into a canned apology (`REFUSAL_FALLBACK_TEXT`) which is persisted like
 * a normal assistant turn. Without further action the flagged user prompt stays
 * in the transcript, so every following turn resends it and re-trips the same
 * refusal — a dead-ended, poisoned conversation.
 *
 * The persisted apology is itself a durable, per-exchange marker of "this
 * exchange was refused". These helpers drop each previously-refused exchange
 * from the working history the provider sees, so the poison never replays. No
 * new storage and no migration: the signal lives in the transcript (source of
 * truth), so an already-poisoned conversation self-heals on its next turn.
 *
 * Host-owned because both sides of the boundary consume it: the runtime
 * assembly (`daemon/conversation-runtime-assembly.ts`) quarantines the message
 * array and the lockstep Slack chronological transcript, and the empty-response
 * plugin's hooks reach the producer/sweep pieces via `@vellumai/plugin-api`
 * re-exports.
 */

import type { ContentBlock, Message } from "../providers/types.js";

/**
 * User-facing text a refusal turn is rewritten into (single source of truth for
 * both the producer — the empty-response plugin's `post-model-call` hook — and
 * the detector below).
 *
 * DETECTION COUPLING: `isRefusalFallbackMessage` matches this string exactly,
 * so it doubles as the quarantine marker for already-persisted transcripts.
 * Editing the wording silently stops the sweep from recognizing conversations
 * poisoned under the old wording (re-introducing the dead-end for that cohort).
 * If the copy must change, keep matching the historical variants too.
 */
export const REFUSAL_FALLBACK_TEXT =
  "Sorry — I wasn't able to generate a response to that. Please try rephrasing or asking in a different way.";

/** A user-role message carrying only tool results, not a fresh prompt. */
export function isToolResultMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}

/** An assistant turn whose entire content is exactly the refusal fallback line. */
export function isRefusalFallbackMessage(message: Message): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const textBlocks = message.content.filter(
    (block): block is Extract<ContentBlock, { type: "text" }> =>
      block.type === "text",
  );
  const hasNonText = message.content.some((block) => block.type !== "text");
  return (
    !hasNonText &&
    textBlocks.length === 1 &&
    textBlocks[0].text.trim() === REFUSAL_FALLBACK_TEXT
  );
}

/**
 * Indices of every message belonging to a previously-refused exchange: for each
 * assistant message that is exactly the refusal fallback, its own index plus the
 * contiguous run back to (and including) the nearest genuine user prompt — the
 * flagged prompt and any tool exchange in that run.
 *
 * Exposed as a set of indices (rather than only the filtered messages) so a
 * caller holding an array rendered in lockstep with `messages` — e.g. the Slack
 * chronological transcript, whose per-message compaction provenance rides in a
 * sibling array — can drop the same exchanges from both and keep them aligned.
 */
export function computeRefusedExchangeDrops(messages: Message[]): {
  dropIndices: Set<number>;
  droppedExchanges: number;
} {
  const dropIndices = new Set<number>();
  let droppedExchanges = 0;
  for (let r = 0; r < messages.length; r++) {
    if (!isRefusalFallbackMessage(messages[r])) {
      continue;
    }
    dropIndices.add(r);
    // Walk back over tool-result / assistant tool churn to the genuine prompt.
    let s = r - 1;
    while (
      s >= 0 &&
      !(messages[s].role === "user" && !isToolResultMessage(messages[s]))
    ) {
      dropIndices.add(s);
      s--;
    }
    if (s >= 0) {
      dropIndices.add(s); // the genuine user prompt that was refused
    }
    droppedExchanges++;
  }
  return { dropIndices, droppedExchanges };
}

/**
 * Remove every previously-refused exchange from a working history: for each
 * assistant message that is exactly the refusal fallback, drop it together with
 * the contiguous run back to (and including) the nearest genuine user prompt.
 * That excises the flagged prompt (and any tool exchange in that run) so the
 * provider never replays it. Returns a new array; the input is untouched.
 */
export function quarantineRefusedExchanges(messages: Message[]): {
  messages: Message[];
  droppedExchanges: number;
} {
  const { dropIndices, droppedExchanges } =
    computeRefusedExchangeDrops(messages);
  if (dropIndices.size === 0) {
    return { messages, droppedExchanges: 0 };
  }
  return {
    messages: messages.filter((_, i) => !dropIndices.has(i)),
    droppedExchanges,
  };
}
