import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeManageWorkflows } from "../../../../tools/workflows/manage-workflows.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeManageWorkflows(input, context);
}
