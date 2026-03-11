import { updateSequence } from "../../../../sequence/store.js";
import type {
  SequenceStatus,
  SequenceStep,
} from "../../../../sequence/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = input.id as string;
  if (!id) return err("id is required.");

  const name = input.name as string | undefined;
  const description = input.description as string | undefined;
  const status = input.status as SequenceStatus | undefined;
  const exitOnReply = input.exit_on_reply as boolean | undefined;
  const stepsRaw = input.steps as Array<Record<string, unknown>> | undefined;

  try {
    const steps = stepsRaw?.map(
      (s, i): SequenceStep => ({
        index: i,
        delaySeconds: (s.delay_seconds as number) ?? 0,
        subjectTemplate: (s.subject as string) ?? `Step ${i + 1}`,
        bodyPrompt: (s.body_prompt as string) ?? "",
        replyToThread: (s.reply_to_thread as boolean) ?? i > 0,
        requireApproval: (s.require_approval as boolean) ?? false,
      }),
    );

    if (steps !== undefined && steps.length === 0) {
      return err(
        "steps must not be empty. A sequence requires at least one step.",
      );
    }

    const updated = updateSequence(id, {
      name,
      description,
      status,
      exitOnReply,
      steps,
    });
    if (!updated) return err(`Sequence not found: ${id}`);

    return ok(`Sequence updated: ${updated.name} (${updated.status})`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
