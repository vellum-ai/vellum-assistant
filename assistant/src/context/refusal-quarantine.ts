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
 * run back to (and including) the genuine user prompt that tripped it — the
 * flagged prompt and any tool exchange in that run.
 *
 * Pairing the fallback with its true prompt:
 *
 * - By default (no `threadKeys`) the walk-back is pure array adjacency: the
 *   nearest preceding genuine user prompt. Correct for a single-party history
 *   (the in-memory working set, a Slack DM) where turns strictly alternate.
 * - In a multi-party Slack channel, another party's post can land between the
 *   refused prompt and the fallback in chronological order, so adjacency would
 *   pair the fallback with that unrelated post and leave the actual refused
 *   prompt behind. `threadKeys` (a per-message Slack thread identity aligned
 *   1:1 with `messages`, `threadTs ?? channelTs`) fixes this: when the
 *   fallback's thread is shared by another message — i.e. it is a real thread,
 *   not a lone top-level/DM row whose key is just its own `channelTs` — the
 *   walk-back keeps only the refused exchange and leaves the rest in place:
 *     - a row in another (non-null) thread is a genuine interleaved post —
 *       left in place;
 *     - a null-keyed row has no Slack provenance. Synthetic tool churn
 *       (assistant `tool_use` turns and their `tool_result` rows) is never
 *       Slack-visible, so it always keys `null` even mid-thread; it belongs to
 *       the refused exchange and is dropped. Leaving it behind would strand
 *       half a tool pair, and the Slack transcript's orphan-tool prune runs
 *       *before* this sweep, so nothing would repair the resulting invalid
 *       history. A null-keyed genuine user prompt is a different turn
 *       (legacy/provenance-less), so it is left in place and the walk continues
 *       to the same-thread prompt.
 *   A `null` fallback key (non-Slack / legacy) always uses adjacency.
 *
 * Exposed as a set of indices (rather than only the filtered messages) so a
 * caller holding an array rendered in lockstep with `messages` — e.g. the Slack
 * chronological transcript, whose per-message compaction provenance rides in a
 * sibling array — can drop the same exchanges from both and keep them aligned.
 */
export function computeRefusedExchangeDrops(
  messages: Message[],
  opts: { threadKeys?: ReadonlyArray<string | null> } = {},
): {
  dropIndices: Set<number>;
  droppedExchanges: number;
} {
  const { threadKeys } = opts;
  // A thread key only carries pairing signal when it is shared: a lone
  // top-level or DM row has its own `channelTs` as its key, so treating it as a
  // one-message "thread" would strand the prompt. Count keys once so each
  // fallback can tell whether it sits in a real (multi-row) thread.
  const sharedThreadKeys = new Set<string>();
  if (threadKeys) {
    const seen = new Set<string>();
    for (const key of threadKeys) {
      if (key === null) {
        continue;
      }
      if (seen.has(key)) {
        sharedThreadKeys.add(key);
      } else {
        seen.add(key);
      }
    }
  }
  const dropIndices = new Set<number>();
  let droppedExchanges = 0;
  for (let r = 0; r < messages.length; r++) {
    if (!isRefusalFallbackMessage(messages[r])) {
      continue;
    }
    dropIndices.add(r);
    const fallbackThreadKey = threadKeys?.[r] ?? null;
    // Scope the walk-back to the fallback's own thread only when that thread is
    // real — shared by another row. A lone top-level/DM row (keyed by its own
    // channelTs) or a provenance-less null key falls through to adjacency.
    const threadScope =
      fallbackThreadKey !== null && sharedThreadKeys.has(fallbackThreadKey)
        ? threadKeys
        : undefined;
    // Walk back to the genuine prompt over tool-result / assistant tool churn.
    for (let s = r - 1; s >= 0; s--) {
      const isGenuinePrompt =
        messages[s].role === "user" && !isToolResultMessage(messages[s]);
      // Under thread scope, leave rows outside the fallback's thread in place —
      // genuine interleaved posts from other (non-null) threads, and
      // provenance-less genuine prompts (someone else's turn). Drop only
      // null-keyed tool churn: this refused exchange's own synthetic
      // tool_use / tool_result rows, which would otherwise strand half a tool
      // pair past the earlier orphan prune.
      if (threadScope) {
        const key = threadScope[s] ?? null;
        if (key !== fallbackThreadKey && (key !== null || isGenuinePrompt)) {
          continue;
        }
      }
      dropIndices.add(s);
      if (isGenuinePrompt) {
        break; // the genuine user prompt that was refused
      }
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
