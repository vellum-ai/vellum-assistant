export const DEFAULT_THEME = "light";

/**
 * The theme a `globalsUpdated` payload selects, or the light theme when the
 * payload carries no theme.
 *
 * Storybook's channel is untyped: `Channel.last()` and the listener argument
 * are both `any`, so the payload is narrowed here rather than declared, and any
 * shape the toolbar sends that lacks a string theme falls back.
 */
export function themeFromGlobalsPayload(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("globals" in payload)
  ) {
    return DEFAULT_THEME;
  }
  const { globals } = payload;
  if (
    typeof globals !== "object" ||
    globals === null ||
    !("theme" in globals)
  ) {
    return DEFAULT_THEME;
  }
  return typeof globals.theme === "string" ? globals.theme : DEFAULT_THEME;
}

/**
 * The theme from the most recent `globalsUpdated` event, which Storybook
 * replays as the event's argument list.
 */
export function themeFromLastGlobalsEvent(lastEventArgs: unknown): string {
  if (!Array.isArray(lastEventArgs)) {
    return DEFAULT_THEME;
  }
  const payload: unknown = lastEventArgs[0];
  return themeFromGlobalsPayload(payload);
}
