import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeRunWorkflow } from "../../../../tools/workflows/run-workflow.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeRunWorkflow(input, context);
}
