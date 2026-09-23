import { z } from "zod";

/**
 * The `ask_question` tool's input as a recorded call carries it, for a client
 * reading one back.
 *
 * The tool's own schema (`askQuestionInputSchema`) is the authority on what a
 * model may send: it caps the batch, bounds the options, carries the
 * descriptions the model reads, and refuses a call that passes both shapes.
 * This one only has to read what was already accepted, so it validates the
 * shape and nothing else, and tolerates a recorded call from an assistant
 * whose bounds differed.
 *
 * Both shapes are here because both are what was asked. `desktopHelp` becomes
 * a one-question prompt inside the daemon, so a reader that only understood
 * `questions` would have nothing to show for a recorded desktop-help call.
 *
 * Structured records win where they exist: the answered record a settled
 * prompt carries (`AnsweredQuestion`) and the live entries an outstanding one
 * has. This is the fallback for a call that has neither, which is any prompt
 * recorded before those records existed, one that timed out, and one whose
 * outstanding entries a reload could not tie back to it.
 */

const RecordedQuestionOptionSchema = z.looseObject({
  id: z.string().optional().catch(undefined),
  label: z.string(),
  description: z.string().optional().catch(undefined),
});

const RecordedQuestionSchema = z.looseObject({
  question: z.string(),
  description: z.string().optional().catch(undefined),
  options: z.array(RecordedQuestionOptionSchema).optional().catch(undefined),
});

export const AskQuestionInputSchema = z.looseObject({
  questions: z.array(RecordedQuestionSchema).optional().catch(undefined),
  desktopHelp: z
    .looseObject({
      message: z.string(),
      doneLabel: z.string().optional().catch(undefined),
      skipLabel: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

export type AskQuestionInput = z.infer<typeof AskQuestionInputSchema>;
export type RecordedQuestion = z.infer<typeof RecordedQuestionSchema>;
