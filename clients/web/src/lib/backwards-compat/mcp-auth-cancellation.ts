/**
 * MCP auth/start supplies attempt_id together with the attempt-scoped cancel
 * route. Responses without it can only stop client-side waiting. Reading the
 * capability from this attempt also supports local builds before a release.
 */
export function mcpCancellationAttemptId(result: {
  attempt_id?: unknown;
}): string | undefined {
  return typeof result.attempt_id === "string" && result.attempt_id.length > 0
    ? result.attempt_id
    : undefined;
}
