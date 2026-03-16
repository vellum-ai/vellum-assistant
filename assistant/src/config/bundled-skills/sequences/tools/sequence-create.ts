import { createSequence } from "../../../../sequence/store.js";
import type { SequenceStep } from "../../../../sequence/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const name = input.name as string;
  const channel = input.channel as string;
  const stepsRaw = input.steps as Array<Record<string, unknown>> | undefined;
  const description = input.description as string | undefined;
  const exitOnReply = input.exit_on_reply as boolean | undefined;

  if (!name) return err("name is required.");
  if (!channel) return err("channel is required.");
  if (!stepsRaw || stepsRaw.length === 0)
    return err("steps array is required and must have at least one step.");

  try {
    const steps: SequenceStep[] = stepsRaw.map((s, i) => ({
      index: i,
      delaySeconds: (s.delay_seconds as number) ?? 0,
      subjectTemplate: (s.subject as string) ?? `Step ${i + 1}`,
      bodyPrompt: (s.body_prompt as string) ?? "",
      replyInSameConversation:
        (s.reply_in_same_conversation as boolean) ?? i > 0,
      requireApproval: (s.require_approval as boolean) ?? false,
    }));

    const sequence = createSequence({
      name,
      channel,
      steps,
      description,
      exitOnReply,
    });
    return ok(
      `Sequence created (ID: ${sequence.id}).\n\nName: ${sequence.name}\nChannel: ${sequence.channel}\nSteps: ${steps.length}\nExit on reply: ${sequence.exitOnReply}\nStatus: ${sequence.status}`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
