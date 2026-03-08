import * as appStore from "../../../../memory/app-store.js";
import { executeAppFileRead } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppFileRead(
    {
      app_id: input.app_id as string,
      path: input.path as string,
      offset: input.offset as number | undefined,
      limit: input.limit as number | undefined,
    },
    appStore,
  );
}
