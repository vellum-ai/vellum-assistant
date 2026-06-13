import {
  readAssistantEvents,
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { buildTranscriptView } from "../../../../../src/lib/transcript-view";
import { LARGEST_SPEND_CATEGORY, OTHER_SPEND_CATEGORIES } from "../constants";

const SUPERLATIVE =
  /\b(largest|biggest|highest|greatest|top|most|number one|#\s?1)\b/i;

function namesCategory(text: string, category: string): boolean {
  return new RegExp(`\\b${category}\\b`, "i").test(text);
}

/**
 * Reconstructs the assistant's final answer message.
 *
 * The Vellum stream lands one transcript turn per `assistant_text_delta`, so
 * the final answer is spread across many fragment turns. `buildTranscriptView`
 * folds consecutive deltas back into whole messages (splitting only on
 * simulator turns), so the last assistant message is the actual answer rather
 * than a trailing token like "$48,200.".
 */
async function readFinalAnswer(runId: string): Promise<string | undefined> {
  const [turns, events] = await Promise.all([
    readTranscript(runId),
    readAssistantEvents(runId),
  ]);
  const finalMessage = buildTranscriptView(turns, events)
    .filter((item) => item.role === "assistant")
    .at(-1);
  if (!finalMessage) return undefined;
  return finalMessage.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Scores whether the assistant named the correct largest spend category.
 *
 * Grades the agent's *final* answer message rather than the whole transcript,
 * so an in-passing mention ("let me check your labor line") while it works does
 * not count. A bare correct answer ("Labor.") passes because the question
 * already frames "largest"; a *wrong* largest claim — a superlative tied to a
 * different category with Labor absent from that clause — fails even if Labor
 * appears elsewhere.
 */
export default async function scoreLargestCategoryFound(
  input: MetricInput,
): Promise<MetricResult> {
  const finalAnswer = await readFinalAnswer(input.runId);

  if (finalAnswer === undefined) {
    return {
      name: "largest-category-found",
      score: 0,
      reason: "Assistant produced no answer turn.",
      metadata: { expectedCategory: LARGEST_SPEND_CATEGORY },
    };
  }

  const namesLabor = namesCategory(finalAnswer, LARGEST_SPEND_CATEGORY);
  const wrongClaim = finalAnswer
    .split(/(?<=[.!?])\s+|\n+/)
    .some(
      (clause) =>
        SUPERLATIVE.test(clause) &&
        !namesCategory(clause, LARGEST_SPEND_CATEGORY) &&
        OTHER_SPEND_CATEGORIES.some((c) => namesCategory(clause, c)),
    );

  const score = namesLabor && !wrongClaim ? 1 : 0;
  let reason: string;
  if (score === 1) {
    reason = `Assistant identified the expected largest spend category (${LARGEST_SPEND_CATEGORY}).`;
  } else if (wrongClaim) {
    reason = `Assistant named a different category as the largest instead of ${LARGEST_SPEND_CATEGORY}.`;
  } else {
    reason = `Assistant did not identify the expected largest spend category (${LARGEST_SPEND_CATEGORY}).`;
  }

  return {
    name: "largest-category-found",
    score,
    reason,
    metadata: { expectedCategory: LARGEST_SPEND_CATEGORY },
  };
}
