import { getSequence, updateSequence } from "../../../../sequence/store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const sequenceId = input.sequence_id as string;
  if (!sequenceId) return err("sequence_id is required.");

  try {
    const seq = getSequence(sequenceId);
    if (!seq) return err(`Sequence not found: ${sequenceId}`);
    if (seq.status === "active") return ok("Sequence is already active.");

    updateSequence(sequenceId, { status: "active" });
    return ok(
      `Sequence "${seq.name}" resumed. Active enrollments will be processed on the next scheduler tick.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
