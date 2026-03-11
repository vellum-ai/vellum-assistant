import {
  countActiveEnrollments,
  listSequences,
} from "../../../../sequence/store.js";
import type { SequenceStatus } from "../../../../sequence/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const status = input.status as SequenceStatus | undefined;

  try {
    const seqs = listSequences(status ? { status } : undefined);
    if (seqs.length === 0) return ok("No sequences found.");

    const lines = seqs.map((s) => {
      const enrollments = countActiveEnrollments(s.id);
      return `- ${s.name} (ID: ${s.id}) — ${s.status}, ${s.steps.length} steps, ${enrollments} active enrollments, channel: ${s.channel}`;
    });
    return ok(`${seqs.length} sequence(s):\n${lines.join("\n")}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
