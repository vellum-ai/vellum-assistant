import { deleteSequence, getSequence } from "../../../../sequence/store.js";
import {
  isAbortLikeError,
  throwIfCancelled,
} from "../../../../tools/shared/abort.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = input.id as string;
  if (!id) {
    return err("id is required.");
  }

  throwIfCancelled(context);

  try {
    const seq = getSequence(id);
    if (!seq) {
      return err(`Sequence not found: ${id}`);
    }

    deleteSequence(id);
    return ok(
      `Sequence "${seq.name}" deleted. All active enrollments have been cancelled.`,
    );
  } catch (e) {
    // A cancelled turn is not a sequence failure: let it reach the executor's
    // abort handling instead of being rendered as a tool error.
    if (isAbortLikeError(e)) {
      throw e;
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}
