import { desktopControl } from "../../../../desktop/desktop-control.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return desktopControl.execute(input, context);
}
