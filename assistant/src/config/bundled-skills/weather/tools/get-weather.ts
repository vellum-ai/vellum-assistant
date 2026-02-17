import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeGetWeather } from '../../../../tools/weather/service.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeGetWeather(input, globalThis.fetch, context.proxyToolResolver);
}
