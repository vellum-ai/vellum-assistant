import type { OAuthConnection } from "../../../../oauth/connection.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

/**
 * Calendar uses the same OAuth credential service as Gmail since both
 * scopes are granted in a single OAuth consent flow.
 */
export async function getCalendarConnection(
  account?: string,
): Promise<OAuthConnection> {
  return resolveOAuthConnection("integration:google", account);
}
