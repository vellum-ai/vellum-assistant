import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as appStore from '../../../../memory/app-store.js';
import { executeAppFileEdit } from '../../../../tools/apps/executors.js';
import type { AppFileEditInput } from '../../../../tools/apps/executors.js';

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppFileEdit(input as unknown as AppFileEditInput, appStore);
}
