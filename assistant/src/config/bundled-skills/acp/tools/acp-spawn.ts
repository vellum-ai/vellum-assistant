import { executeAcpSpawn } from "../../../../tools/acp/spawn.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeAcpSpawn(input, context);
}
