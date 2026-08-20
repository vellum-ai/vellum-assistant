/**
 * Reconcile the ask_question card against the daemon's pending-interactions
 * registry.
 *
 * The registry is the authority on whether a prompt is still awaiting an
 * answer: the daemon registers an interaction before it broadcasts
 * `question_request` and deletes it the instant the answer lands, so its
 * conversation-scoped read answers "is a card owed here?" without reference to
 * anything the client has cached. That matters because the client's other
 * source for this (the `pendingQuestion` marker the daemon stamps onto a
 * history tool call at render time) is registry state living inside a cacheable
 * payload, and a cached page keeps reporting a prompt that was answered turns
 * ago.
 *
 * Kept as a pure decision so the raise/retire rules are testable without a
 * query client, a store, or a rendered card. The caller applies the action and
 * owns the races around it (see `use-conversation-history`).
 */

import type { PendingQuestionState } from "@/types/interaction-ui-types";
import type { QuestionEntry } from "@vellumai/assistant-api";

/**
 * The registry's answer for one conversation, straight off the wire.
 *
 * All three values are distinct and load-bearing:
 *
 * - an object: this prompt is outstanding,
 * - `null`: the registry positively reports nothing outstanding,
 * - `undefined`: the assistant predates the field, so the response carries no
 *   opinion at all. That is capability detection rather than a version gate.
 *   The shape itself says whether the answer is trustworthy, which a version
 *   comparison cannot do before the identity fetch hydrates (and gets wrong for
 *   same-source self-hosted setups that report a stale released version). It
 *   mirrors the cold-boot landing read documented in `docs/BACKWARDS_COMPAT.md`
 *   under related compatibility seams.
 */
export type ReportedQuestion =
  | { requestId: string; entries: QuestionEntry[] }
  | null
  | undefined;

/** What the caller should do to the card currently on screen. */
export type PendingQuestionAction =
  | { kind: "raise"; question: PendingQuestionState }
  | { kind: "retire"; requestId: string }
  | { kind: "none" };

const NONE: PendingQuestionAction = { kind: "none" };

/**
 * Decide the card state one registry read implies.
 *
 * Retiring is the half the client has never had: every earlier restore path
 * could raise a card and none could take one away, so a prompt resolved while
 * the client wasn't looking (answered from a channel, superseded, timed out, or
 * answered here before a chat switch dropped the store) stayed on screen until
 * the user answered it again into a 404.
 */
export function decidePendingQuestion(params: {
  reported: ReportedQuestion;
  current: PendingQuestionState | null;
}): PendingQuestionAction {
  const { reported, current } = params;

  // No opinion available: leave whatever is on screen alone, including a card
  // the legacy history-marker restore raised.
  if (reported === undefined) {
    return NONE;
  }

  if (reported === null) {
    return current ? { kind: "retire", requestId: current.requestId } : NONE;
  }

  // A prompt with no questions cannot be rendered (`QuestionPromptCard` warns
  // and bails), so it is not something to raise. Nor is it grounds to retire a
  // card that is rendering fine: a batch this malformed says the registry entry
  // is wrong, not that the user is done answering.
  if (reported.entries.length === 0) {
    return NONE;
  }

  if (current?.requestId === reported.requestId) {
    return NONE;
  }

  return {
    kind: "raise",
    question: { requestId: reported.requestId, entries: reported.entries },
  };
}
