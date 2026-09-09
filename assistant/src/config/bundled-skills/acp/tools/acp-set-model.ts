import { executeAcpSetModel } from "../../../../tools/acp/set-model.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAcpSetModel(input, context);
}
