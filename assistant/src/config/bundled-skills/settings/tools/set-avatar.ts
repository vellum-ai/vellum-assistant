import { setAvatarTool } from "../../../../tools/system/avatar-generator.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return setAvatarTool.execute(input, context);
}
