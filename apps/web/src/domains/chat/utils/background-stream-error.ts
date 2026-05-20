// Errors thrown by `subscribeChatEvents` when the for-await loop exits and
// every reconnect attempt also fails to receive an event. The watchdog already
// captures the root signal via the `sse_watchdog_fired` Sentry message; these
// downstream errors duplicate that signal as a separate Sentry issue when
// surfaced via `captureException`. Match against this set in callers and
// downgrade to a Sentry breadcrumb so the fleet-wide error count is not
// inflated by reconnect-exhaustion noise from a single stalled session.
const EXPECTED_BACKGROUND_STREAM_END_MESSAGES: ReadonlySet<string> = new Set([
  "Stream ended unexpectedly",
  "Stream connection failed",
]);

export function isExpectedBackgroundStreamEnd(err: Error): boolean {
  return EXPECTED_BACKGROUND_STREAM_END_MESSAGES.has(err.message);
}
