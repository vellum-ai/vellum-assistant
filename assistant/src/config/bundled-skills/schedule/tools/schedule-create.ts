import { executeScheduleCreate } from "../../../../tools/schedule/create.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeScheduleCreate(input, context);
}
