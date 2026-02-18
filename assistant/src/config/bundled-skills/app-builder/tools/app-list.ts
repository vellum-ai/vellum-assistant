import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as appStore from '../../../../memory/app-store.js';
import { executeAppList } from '../../../../tools/apps/executors.js';

export async function run(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppList(appStore);
}
