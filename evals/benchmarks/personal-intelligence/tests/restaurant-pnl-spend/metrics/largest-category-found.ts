import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { LARGEST_SPEND_CATEGORY, OTHER_SPEND_CATEGORIES } from "../constants";

const SUPERLATIVE =
  /\b(largest|biggest|highest|greatest|top|most|number one|#\s?1)\b/i;

function namesCategory(text: string, category: string): boolean {
  return new RegExp(`\\b${category}\\b`, "i").test(text);
}

/**
 * Scores whether the assistant named the correct largest spend category.
 *
 * Grades the agent's *final* answer turn rather than the whole transcript, so
 * an in-passing mention ("let me check your labor line") while it works does
 * not count. A bare correct answer ("Labor.") passes because the question
 * already frames "largest"; a *wrong* largest claim — a superlative tied to a
 * different category with Labor absent from that clause — fails even if Labor
 * appears elsewhere.
 */
export default async function scoreLargestCategoryFound(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const finalAnswer = transcript
    .filter((turn) => turn.role === "assistant")
    .at(-1)?.content;

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
