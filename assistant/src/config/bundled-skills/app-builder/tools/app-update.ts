import * as appStore from "../../../../memory/app-store.js";
import { executeAppUpdate } from "../../../../tools/apps/executors.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppUpdate(
    {
      app_id: input.app_id as string,
      name: input.name as string | undefined,
      description: input.description as string | undefined,
      schema_json: input.schema_json as string | undefined,
      html: input.html as string | undefined,
      pages: input.pages as Record<string, string> | undefined,
    },
    appStore,
  );
}
