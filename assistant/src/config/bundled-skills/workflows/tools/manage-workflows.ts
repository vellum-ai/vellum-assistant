import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeManageWorkflows } from "../../../../tools/workflows/manage-workflows.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeManageWorkflows(input, context);
}
