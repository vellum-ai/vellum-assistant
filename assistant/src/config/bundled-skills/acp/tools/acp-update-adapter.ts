import { executeAcpUpdateAdapter } from "../../../../tools/acp/spawn.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export async function run(
  _input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return executeAcpUpdateAdapter();
}
