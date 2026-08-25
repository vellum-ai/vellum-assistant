/**
 * Backwards-compat gate: batched ask-question submissions.
 *
 * `POST /v1/question-response` accepts two answer shapes. The batched
 * `{ kind: "submit", responses }` carries one entry per question in the card,
 * and each entry can be `option`, `free_text`, or `skip`. The legacy
 * single-question `{ kind: "option" | "free_text", ... }` answers a
 * one-question card only, and has no way to say "skipped".
 *
 * - Old behavior (< MIN_VERSION): a one-entry submission is downgraded to the
 *   legacy shape, and a skip is sent as `free_text` with empty text because
 *   that shape cannot express one. The daemon records a blank free-text
 *   answer, and the model is told the user typed nothing rather than that the
 *   user declined to answer.
 * - New behavior (>= MIN_VERSION): every submission is batched, so a skip
 *   stays a skip all the way to the persisted record and the tool result.
 *
 * Scoped to the assistant the card belongs to: an answer is posted to a
 * specific assistant, and a version fetched for the outgoing assistant must
 * not decide the wire shape for the incoming one.
 *
 * MIN_VERSION is a released number rather than a dev floor, per the guidance
 * in `docs/BACKWARDS_COMPAT.md`: the batched contract shipped in 0.8.2
 * (2026-05-15), so the floor is a fact rather than a prediction. The route and
 * the per-question metadata it validates against landed together, so no build
 * serves one without the other.
 */

import {
  assistantScopedSupports,
  whenAssistantVersionKnownFor,
} from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.8.2";

/**
 * Whether `assistantId` accepts the batched submission shape.
 *
 * Conservative (`false`) until the scoped version hydrates and on any owner
 * mismatch, which sends the legacy shape. Every assistant understands that
 * shape, so a wrong `false` costs the skip distinction rather than the answer.
 */
function supportsBatchedQuestionSubmit(
  assistantId: string | null | undefined,
): boolean {
  return assistantScopedSupports(MIN_VERSION, assistantId);
}

/**
 * The same gate for the submit path, resolving the version first.
 *
 * Answering is a write whose legacy fallback is accepted by every assistant,
 * so reading the pre-hydration `false` would quietly send the lossy shape to
 * an assistant that had no need of it. The scoped wait is the one that matches
 * the read: the unscoped wait is satisfied by a version still held for another
 * assistant, which the owner check answers `false` on anyway.
 */
export async function resolveSupportsBatchedQuestionSubmit(
  assistantId: string | null | undefined,
): Promise<boolean> {
  await whenAssistantVersionKnownFor(assistantId);
  return supportsBatchedQuestionSubmit(assistantId);
}
