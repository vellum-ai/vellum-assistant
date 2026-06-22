import {
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { classifyWithJudge } from "../../../../../src/lib/llm-judge";
import { HIGHEST_TOKEN_MODEL, USAGE_MODELS } from "../constants";
import { readFinalAnswer } from "../transcript-answer";

const METRIC_NAME = "highest-token-model";

/** Sentinel the judge returns when the answer names no clear top model. */
const NO_MODEL = "none";

/** Models the judge may choose from, plus the no-claim sentinel. */
const JUDGE_MODEL_CHOICES = [...USAGE_MODELS, NO_MODEL];

/**
 * Classifies which model an answer reports as having the highest total token
 * usage. Injected in tests; defaults to a Haiku judge so reformatted names
 * (e.g. "Claude Sonnet 4.6") and prose phrasing are judged on meaning rather
 * than matched by a regex.
 */
export type ClaimedTopModelClassifier = (answer: string) => Promise<string>;

async function classifyClaimedTopModel(answer: string): Promise<string> {
  const verdict = await classifyWithJudge({
    system: [
      "You grade an eval answer about product LLM-usage analytics.",
      "The assistant was asked to total tokens grouped by model across a customer base.",
      "Decide which single model the answer reports as having the HIGHEST total token usage overall (input + output summed).",
      "Judge only a claim about the top model across the whole dataset, not a model that merely leads one customer or one metric.",
      `If the answer names no clear top model (e.g. it could not read the data, or only describes the dashboard without a leader), choose "${NO_MODEL}".`,
      'Map a reformatted name onto its token, e.g. "Claude Sonnet 4.6" -> "claude-sonnet-4-6".',
    ].join("\n"),
    user: `Assistant answer:\n\n${answer}`,
    tool: {
      name: "report_top_model",
      description:
        "Report which model the assistant claimed has the highest total token usage overall.",
      inputSchema: {
        type: "object",
        properties: {
          model: {
            type: "string",
            enum: JUDGE_MODEL_CHOICES,
            description:
              "The model the answer claims has the highest total token usage, or the no-claim sentinel.",
          },
        },
        required: ["model"],
      },
    },
  });
  return String(verdict.model ?? NO_MODEL);
}

function scoreClaimedModel(claimed: string): MetricResult {
  const score = claimed === HIGHEST_TOKEN_MODEL ? 1 : 0;
  let reason: string;
  if (score === 1) {
    reason = `Assistant identified the expected highest-token model (${HIGHEST_TOKEN_MODEL}).`;
  } else if (claimed === NO_MODEL) {
    reason = `Assistant did not identify a highest-token model (expected ${HIGHEST_TOKEN_MODEL}).`;
  } else {
    reason = `Assistant claimed ${claimed} has the highest token usage instead of ${HIGHEST_TOKEN_MODEL}.`;
  }
  return {
    name: METRIC_NAME,
    score,
    reason,
    metadata: {
      expectedModel: HIGHEST_TOKEN_MODEL,
      claimedModel: claimed,
    },
  };
}

/**
 * Scores whether the assistant named the correct highest-token model.
 *
 * Grades the agent's *final* answer message rather than the whole transcript,
 * so an in-passing mention while it works does not count. The claimed top model
 * is resolved by an LLM judge, so a bare correct answer passes and a model that
 * merely leads one slice is not mistaken for the overall leader.
 */
export default async function scoreHighestTokenModel(
  input: MetricInput,
  classify: ClaimedTopModelClassifier = classifyClaimedTopModel,
): Promise<MetricResult> {
  const finalAnswer = await readFinalAnswer(input.runId);

  if (finalAnswer === undefined || finalAnswer.trim() === "") {
    return {
      name: METRIC_NAME,
      score: 0,
      reason: "Assistant produced no answer turn.",
      metadata: { expectedModel: HIGHEST_TOKEN_MODEL },
    };
  }

  const claimed = await classify(finalAnswer);
  return scoreClaimedModel(claimed);
}
