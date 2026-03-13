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
export function getCalendarConnection(
  account?: string,
  calendarId?: string,
): OAuthConnection {
  // If no explicit account but calendar_id looks like an email, use it as the account hint
  const resolved =
    account ?? (calendarId?.includes("@") ? calendarId : undefined);
  return resolveOAuthConnection("integration:google", resolved);
}
