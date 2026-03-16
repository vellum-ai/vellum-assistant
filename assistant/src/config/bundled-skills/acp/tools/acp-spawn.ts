import { executeAcpSpawn } from "../../../../tools/acp/spawn.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAcpSpawn(input, context);
}
