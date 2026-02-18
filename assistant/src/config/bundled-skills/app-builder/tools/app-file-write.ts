import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as appStore from '../../../../memory/app-store.js';
import { executeAppFileWrite } from '../../../../tools/apps/executors.js';
import type { AppFileWriteInput } from '../../../../tools/apps/executors.js';

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppFileWrite(input as unknown as AppFileWriteInput, appStore);
}
