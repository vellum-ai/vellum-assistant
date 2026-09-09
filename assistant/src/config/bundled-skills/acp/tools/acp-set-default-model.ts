import { executeAcpSetDefaultModel } from "../../../../tools/acp/set-default-model.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAcpSetDefaultModel(input, context);
}
