import {
  readAssistantEvents,
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { buildTranscriptView } from "../../../../../src/lib/transcript-view";
import { classifyWithJudge } from "../../../../../src/lib/llm-judge";
import { LARGEST_SPEND_CATEGORY, OTHER_SPEND_CATEGORIES } from "../constants";

const METRIC_NAME = "largest-category-found";

/** Sentinel the judge returns when the answer names no clear largest category. */
const NO_CATEGORY = "none";

/** Categories the judge may choose from, plus the no-claim sentinel. */
const JUDGE_CATEGORY_CHOICES = [
  LARGEST_SPEND_CATEGORY,
  ...OTHER_SPEND_CATEGORIES,
  NO_CATEGORY,
];

/**
 * Classifies which spend category an answer claims is the largest. Injected in
 * tests; defaults to a Haiku judge so phrasing variance (e.g. a superlative
 * scoped to "line items within that category") is judged on meaning rather
 * than matched by a regex that can't tell scope from a top-category claim.
 */
export type ClaimedCategoryClassifier = (answer: string) => Promise<string>;

/**
 * Reconstructs the assistant's final answer message.
 *
 * The Vellum stream lands one transcript turn per `assistant_text_delta`, so
 * the final answer is spread across many fragment turns. `buildTranscriptView`
 * folds consecutive deltas back into whole messages (splitting only on
 * simulator turns) and keeps thinking blocks separate, so the last assistant
 * message's text blocks are the actual answer rather than a trailing token
 * like "$48,200." or an internal reasoning fragment.
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

async function classifyClaimedLargestCategory(answer: string): Promise<string> {
  const verdict = await classifyWithJudge({
    system: [
      "You grade an eval answer about restaurant P&L spending.",
      "Decide which single spend category the answer claims is the LARGEST overall.",
      "Judge only a claim about the top category across the whole P&L.",
      'Ignore superlatives scoped to sub-items, e.g. "the biggest line items within that category" describes items inside one category, not the largest category overall.',
      `If the answer names no clear largest category (e.g. it says it could not find the data), choose "${NO_CATEGORY}".`,
      'Map a longer name onto its token, e.g. "Food & Beverage" -> "Food".',
    ].join("\n"),
    user: `Assistant answer:\n\n${answer}`,
    tool: {
      name: "report_largest_category",
      description:
        "Report which spend category the assistant claimed is the largest overall.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: JUDGE_CATEGORY_CHOICES,
            description:
              "The category the answer claims is the largest overall, or the no-claim sentinel.",
          },
        },
        required: ["category"],
      },
    },
  });
  return String(verdict.category ?? NO_CATEGORY);
}

function scoreClaimedCategory(claimed: string): MetricResult {
  const score = claimed === LARGEST_SPEND_CATEGORY ? 1 : 0;
  let reason: string;
  if (score === 1) {
    reason = `Assistant identified the expected largest spend category (${LARGEST_SPEND_CATEGORY}).`;
  } else if (claimed === NO_CATEGORY) {
    reason = `Assistant did not identify a largest spend category (expected ${LARGEST_SPEND_CATEGORY}).`;
  } else {
    reason = `Assistant claimed ${claimed} is the largest spend category instead of ${LARGEST_SPEND_CATEGORY}.`;
  }
  return {
    name: METRIC_NAME,
    score,
    reason,
    metadata: {
      expectedCategory: LARGEST_SPEND_CATEGORY,
      claimedCategory: claimed,
    },
  };
}

/**
 * Scores whether the assistant named the correct largest spend category.
 *
 * Grades the agent's *final* answer message rather than the whole transcript,
 * so an in-passing mention ("let me check your labor line") while it works does
 * not count. The claimed largest category is resolved by an LLM judge, so a
 * bare correct answer ("Labor.") passes (the question already frames "largest")
 * and a superlative scoped to one category's internal line items does not get
 * mistaken for a competing top-category claim.
 */
export default async function scoreLargestCategoryFound(
  input: MetricInput,
  classify: ClaimedCategoryClassifier = classifyClaimedLargestCategory,
): Promise<MetricResult> {
  const finalAnswer = await readFinalAnswer(input.runId);

  if (finalAnswer === undefined || finalAnswer.trim() === "") {
    return {
      name: METRIC_NAME,
      score: 0,
      reason: "Assistant produced no answer turn.",
      metadata: { expectedCategory: LARGEST_SPEND_CATEGORY },
    };
  }

  const claimed = await classify(finalAnswer);
  return scoreClaimedCategory(claimed);
}
