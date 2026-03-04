import { withValidToken } from "../../../../security/token-manager.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

/**
 * Calendar uses the same OAuth credential service as Gmail since both
 * scopes are granted in a single OAuth consent flow.
 */
export async function withCalendarToken<T>(
  fn: (token: string) => Promise<T>,
): Promise<T> {
  return withValidToken("integration:gmail", fn);
}
