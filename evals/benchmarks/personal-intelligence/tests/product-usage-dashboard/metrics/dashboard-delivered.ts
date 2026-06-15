import {
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { classifyWithJudge } from "../../../../../src/lib/llm-judge";
import { readAssistantNarration } from "../transcript-answer";

const METRIC_NAME = "dashboard-delivered";

/** Outcomes the judge may report for the assistant's deliverable. */
const DASHBOARD = "dashboard";
const ANALYSIS_ONLY = "analysis_only";
const NOTHING = "nothing";
const JUDGE_OUTCOME_CHOICES = [DASHBOARD, ANALYSIS_ONLY, NOTHING];

/**
 * Classifies what the assistant actually delivered. Injected in tests;
 * defaults to a Haiku judge so the difference between "built a dashboard
 * artifact" and "answered in prose" is judged on meaning across phrasings.
 */
export type DeliverableClassifier = (narration: string) => Promise<string>;

async function classifyDeliverable(narration: string): Promise<string> {
  const verdict = await classifyWithJudge({
    system: [
      "You grade an eval where the user asked the assistant to build a dashboard of product usage (tokens grouped by model).",
      "Read the assistant's side of the conversation and decide what it actually delivered.",
      `Choose "${DASHBOARD}" if the assistant produced a dashboard or visualization artifact — e.g. it wrote/saved an HTML or notebook file, rendered charts, or served a page the user can open.`,
      `Choose "${ANALYSIS_ONLY}" if it only answered in text (a written summary or a plain table) without producing a dashboard/visualization artifact.`,
      `Choose "${NOTHING}" if it delivered neither — e.g. it could not read the data or never completed the task.`,
      "Judge what was delivered, not whether the numbers are correct.",
    ].join("\n"),
    user: `Assistant conversation:\n\n${narration}`,
    tool: {
      name: "report_deliverable",
      description:
        "Report what the assistant delivered in response to the dashboard request.",
      inputSchema: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            enum: JUDGE_OUTCOME_CHOICES,
            description:
              "What the assistant delivered: a dashboard artifact, a text-only analysis, or nothing.",
          },
        },
        required: ["outcome"],
      },
    },
  });
  return String(verdict.outcome ?? NOTHING);
}

function scoreDeliverable(outcome: string): MetricResult {
  const score = outcome === DASHBOARD ? 1 : 0;
  let reason: string;
  if (outcome === DASHBOARD) {
    reason = "Assistant delivered a dashboard/visualization artifact.";
  } else if (outcome === ANALYSIS_ONLY) {
    reason =
      "Assistant answered in text only and did not build a dashboard artifact.";
  } else {
    reason = "Assistant delivered neither a dashboard nor a usable analysis.";
  }
  return {
    name: METRIC_NAME,
    score,
    reason,
    metadata: { outcome },
  };
}

/**
 * Scores whether the assistant actually built the requested dashboard rather
 * than only replying with prose or a table.
 *
 * Reads the whole assistant side of the conversation (the artifact is often
 * announced before the closing summary) and routes the judgement through an
 * LLM judge, since "delivered a dashboard" is a semantic claim that a regex
 * over file-extension mentions would get wrong.
 */
export default async function scoreDashboardDelivered(
  input: MetricInput,
  classify: DeliverableClassifier = classifyDeliverable,
): Promise<MetricResult> {
  const narration = await readAssistantNarration(input.runId);

  if (narration === undefined) {
    return {
      name: METRIC_NAME,
      score: 0,
      reason: "Assistant produced no response.",
      metadata: { outcome: NOTHING },
    };
  }

  const outcome = await classify(narration);
  return scoreDeliverable(outcome);
}
