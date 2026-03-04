import type { ToolExecutionResult } from "./service.js";
import { executeGetWeather } from "./service.js";

interface ToolContext {
  proxyToolResolver?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeGetWeather(input, globalThis.fetch, context.proxyToolResolver);
}
