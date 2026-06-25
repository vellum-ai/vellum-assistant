import { deleteSequence, getSequence } from "../../../../sequence/store.js";
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

  try {
    const seq = getSequence(id);
    if (!seq) return err(`Sequence not found: ${id}`);

    deleteSequence(id);
    return ok(
      `Sequence "${seq.name}" deleted. All active enrollments have been cancelled.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
