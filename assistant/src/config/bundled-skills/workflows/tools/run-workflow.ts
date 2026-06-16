import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeRunWorkflow } from "../../../../tools/workflows/run-workflow.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRunWorkflow(input, context);
}
