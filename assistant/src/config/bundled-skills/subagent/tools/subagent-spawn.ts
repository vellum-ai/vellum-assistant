import { executeSubagentSpawn } from "../../../../tools/subagent/spawn.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentSpawn(input, context);
}
