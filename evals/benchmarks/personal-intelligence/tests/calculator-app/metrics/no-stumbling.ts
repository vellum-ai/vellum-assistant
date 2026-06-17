import {
  hasAssistantResponse,
  readAssistantEvents,
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { buildTranscriptView } from "../../../../../src/lib/transcript-view";
import { classifyWithJudge } from "../../../../../src/lib/llm-judge";

const METRIC_NAME = "no-stumbling";

/**
 * Decides whether the assistant's user-facing narration admits stumbling.
 * Injected in tests; defaults to a Haiku judge so a phrase like "let me try a
 * different layout" is read by intent rather than tripping a regex that can't
 * tell a routine next step from an admission that something failed.
 */
export type StumbleClassifier = (narration: string) => Promise<boolean>;

/**
 * The assistant's user-visible narration across the whole run.
 *
 * Built from the folded transcript's `text` blocks only: stumbling is about
 * what the agent tells the user, so internal `thinking` blocks (where "let me
 * try another approach" is healthy reasoning, not a stumble) are excluded.
 * Folding coalesces the per-delta Vellum stream back into whole messages so a
 * phrase split across fragments reads as one sentence.
 */
async function readVisibleNarration(runId: string): Promise<string> {
  const [turns, events] = await Promise.all([
    readTranscript(runId),
    readAssistantEvents(runId),
  ]);
  return buildTranscriptView(turns, events)
    .filter((item) => item.role === "assistant")
    .flatMap((item) => item.blocks)
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n");
}

async function judgeStumbled(narration: string): Promise<boolean> {
  const verdict = await classifyWithJudge({
    system: [
      "You grade an eval where an assistant builds something for a user.",
      "Decide whether the assistant's user-facing narration admits STUMBLING:",
      "telling the user that an attempt failed, that it is confused, or that it",
      'is retrying after something went wrong (e.g. "that didn\'t work", "let',
      'me try again", "hmm, that failed", "oops").',
      "Routine progress narration is NOT stumbling: describing the next step,",
      'offering alternatives ("I can also add a percent key"), or laying out a',
      "plan does not count unless it frames a prior attempt as having failed.",
      "Judge the narration as a whole, by intent, not by isolated keywords.",
    ].join("\n"),
    user: `Assistant's user-facing narration:\n\n${narration}`,
    tool: {
      name: "report_stumbling",
      description:
        "Report whether the assistant narrated stumbling, failure, or retries to the user.",
      inputSchema: {
        type: "object",
        properties: {
          stumbled: {
            type: "boolean",
            description:
              "True if the narration admits a failed attempt, confusion, or a retry; false otherwise.",
          },
        },
        required: ["stumbled"],
      },
    },
  });
  if (typeof verdict.stumbled !== "boolean") {
    throw new Error(
      `no-stumbling judge returned a non-boolean verdict: ${JSON.stringify(verdict)}`,
    );
  }
  return verdict.stumbled;
}

/**
 * Scores whether the assistant got through the task without narrating
 * stumbling to the user. An LLM judge reads the agent's visible narration, so
 * a routine next-step phrase ("let me add the operation buttons") is not
 * mistaken for an admission that a prior attempt failed.
 */
export default async function scoreNoStumbling(
  input: MetricInput,
  judge: StumbleClassifier = judgeStumbled,
): Promise<MetricResult> {
  if (!(await hasAssistantResponse(input.runId))) {
    return {
      name: METRIC_NAME,
      score: 0,
      reason: "No assistant responses to evaluate.",
      metadata: { stumbled: null },
    };
  }

  const narration = await readVisibleNarration(input.runId);
  if (narration.trim() === "") {
    return {
      name: METRIC_NAME,
      score: 1,
      reason:
        "Assistant produced no user-facing narration; no stumbling to flag.",
      metadata: { stumbled: false },
    };
  }

  const stumbled = await judge(narration);
  return {
    name: METRIC_NAME,
    score: stumbled ? 0 : 1,
    reason: stumbled
      ? "Assistant narrated stumbling or retries to the user."
      : "Assistant never narrated stumbling or retries.",
    metadata: { stumbled },
  };
}
