import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as appStore from '../../../../memory/app-store.js';
import { executeAppCreate } from '../../../../tools/apps/executors.js';
import type { AppCreateInput } from '../../../../tools/apps/executors.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeAppCreate(
    input as unknown as AppCreateInput,
    appStore,
    context.proxyToolResolver,
  );
}
