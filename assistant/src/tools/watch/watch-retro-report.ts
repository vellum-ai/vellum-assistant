import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/**
 * How a watch retrospective hands its report to the daemon.
 *
 * **The card cannot come from `ui_show`.** A retrospective runs as a
 * `clientless` wake, which pins the turn non-interactive, and
 * `conversation-tool-setup` gates the whole `ui_surface` tool family on a
 * client being present (`return channelCapabilities?.supportsDynamicUi ??
 * !hasNoClient`). So `ui_show` is not merely denied in this turn, it is absent
 * from the tool set, and a retrospective told to call it can only report that
 * it cannot. This tool is an ordinary one and passes that gate untouched.
 *
 * **It records; it does not render.** The executor validates the payload and
 * returns, and nothing here writes to the conversation. What makes the card is
 * `watch-retro.ts` reading this call back out of the turn's own history once
 * the turn has finished, and appending the `ui_surface` block itself. Two
 * reasons for the split. A surface appended from inside the turn can land
 * between a persisted `tool_use` and its `tool_result`, which is the ordering
 * hazard the memory retrospective's skill card defers around
 * (`memory-retrospective-skill-card.ts`); waiting until the turn is over avoids
 * it rather than detecting it. And the report is then held in the one place
 * that survives a crash between the call and the append: the transcript.
 *
 * **Validation is the model-facing half.** The payload is the card's own
 * shape, so one the renderer could not draw is refused here, while the model
 * still has a turn left to correct it. The daemon parses it again before
 * appending, since a tool result is not a promise about what was persisted.
 *
 * **Questions are validated by shape, and the shape is not advertised.** The
 * surface schema is tolerant and strips what it does not recognize, so a
 * question sent as `question`/`value` instead of `prompt`/`label` parses clean
 * and draws a page with no text on it. Checking the shape here turns that into
 * a rejection naming the field, which the model has a turn left to act on.
 * Advertising it too would be the surer teacher, but the always-loaded payload
 * is within a few hundred bytes of the budget
 * (`browser-skill-baseline-tool-payload`) and the question shape is around 450
 * of them, spent on every request by every caller for a tool one flow uses.
 * The divergence is safe in a way the general rule in `zod-tool-schema.ts`
 * warns it is not: a model reaching this tool has been sent here by
 * `RETRO_INSTRUCTIONS`, which names every field, so there is no caller that
 * sees the terse schema without the contract.
 */

/** One alternative on a `pick` or a `gate`. */
const questionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  note: z.string().optional().catch(undefined),
});

/**
 * One question, held to what the card can actually page through.
 *
 * A `pick` or a `gate` with fewer than two options is one button, which is not
 * a question, and the renderer drops it. More than four is the questionnaire
 * the paging exists to avoid, on a page that then scrolls. Rejecting either
 * here means the model hears about the gap it could not name instead of the
 * user reading a page that is missing or too long to tap through.
 */
const questionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["fill", "pick", "gate"]),
    prompt: z.string().min(1),
    eyebrow: z.string().optional().catch(undefined),
    suggestion: z.string().optional().catch(undefined),
    // No `.catch`, for the same reason `questions` has none, and for one more:
    // a swallowed option array reads as an empty one, so a mistyped `label`
    // would come back as the count complaint below. That answer sends the
    // model to add options it already sent.
    options: z.array(questionOptionSchema).optional(),
  })
  .refine(
    (question) => {
      if (question.kind === "fill") {
        return true;
      }
      const count = question.options?.length ?? 0;
      return count >= 2 && count <= 4;
    },
    {
      error: 'a "pick" or "gate" needs two to four options',
      path: ["options"],
    },
  );

export const watchRetroReportInputSchema = z.looseObject({
  task: z.string(),
  purpose: z.string().optional().catch(undefined),
  steps: z.array(z.string()).optional().catch(undefined),
  eyebrow: z.string().optional().catch(undefined),
  coverage: z.string().optional().catch(undefined),
  // No `.catch` here, unlike the decoration around it. A swallowed questions
  // array is the failure this schema exists to report: the card would draw
  // without the pages the model meant to ask on, and nothing would say so.
  questions: z.array(questionSchema).optional(),
});

/**
 * The same payload with the question shape left off, which is what the model
 * is shown. Derived from the validating schema rather than written out beside
 * it, so the fields around `questions` cannot drift from what is enforced.
 * See the note above on why this one field is not advertised.
 */
const watchRetroReportAdvertisedSchema = watchRetroReportInputSchema.extend({
  questions: z.array(z.unknown()).optional(),
});

/**
 * The first id used by more than one question, or null when they are distinct.
 *
 * Checked here rather than in the schema because the renderer's response to a
 * repeat is to drop the later question, not to fail: the id is the key an
 * answer is held under, so two questions sharing one would submit whichever
 * answer landed last for both.
 */
function firstDuplicateQuestionId(
  questions: readonly { id: string }[] | undefined,
): string | null {
  const seen = new Set<string>();
  for (const question of questions ?? []) {
    if (seen.has(question.id)) {
      return question.id;
    }
    seen.add(question.id);
  }
  return null;
}

export async function executeWatchRetroReport(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = watchRetroReportInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("watch_retro_report", parsed.error);
  }
  const { task, steps, questions } = parsed.data;
  if (!task || task.trim().length === 0) {
    return {
      content: '"task" is required: name the task the session recorded.',
      isError: true,
    };
  }
  // A record with no steps is not a record. The questions are optional and the
  // rest is decoration, but a card whose first page is a bare title tells the
  // user nothing about the session they just finished.
  if (!steps || steps.length === 0) {
    return {
      content:
        '"steps" is required: list what you saw, in order, as short imperative fragments.',
      isError: true,
    };
  }
  // Last, because the record is the part a card cannot do without and a report
  // missing it should hear about that first.
  const duplicateId = firstDuplicateQuestionId(questions);
  if (duplicateId !== null) {
    return {
      content: `Two questions share the id "${duplicateId}". An id is the handle an answer comes back under, so the card keeps the first question and drops the rest. Give each one its own.`,
      isError: true,
    };
  }
  return {
    content: JSON.stringify({ recorded: true, steps: steps.length }),
    isError: false,
  };
}

export const watchRetroReportTool = {
  name: "watch_retro_report",
  // Deliberately terse, field descriptions included: this tool is always
  // registered, so every byte here is spent on every request. The contract is
  // carried by the retrospective prompt, its only caller, and enforced by the
  // validating schema above, which is stricter than what this advertises.
  // `browser-skill-baseline-tool-payload` holds the total to a budget.
  description:
    "Report what a Watch (teach mode) session recorded. Only from a watch retrospective, which gives the payload shape.",
  category: "ui-surface",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: toToolInputSchema(watchRetroReportAdvertisedSchema, {
    advertiseRequired: ["task", "steps"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeWatchRetroReport(input, context);
  },
} satisfies ToolDefinition;
