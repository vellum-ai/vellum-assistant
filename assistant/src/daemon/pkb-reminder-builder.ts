const BODY =
  "\nCall `remember` this turn for anything concrete the user said — facts, preferences, plans, names, dates, decisions, corrections, felt moments. Default to remembering; skip only obvious noise. This should be your most frequently used tool." +
  "\nIf you're unsure about something that may live in the workspace — past decisions, prior conversations, files — use `recall` before asking or guessing." +
  "\nRead any unread workspace files that look even partially relevant.";

/**
 * Render the PKB system_reminder text, optionally with a bulleted list of
 * hint paths that look especially relevant to the current conversation.
 *
 * When `hints` is empty, returns the base reminder byte-for-byte.
 * When `hints` is non-empty, renders an extended reminder with a bullet per
 * hint. Hints are emitted verbatim — they are trusted internal paths, not
 * user input, so no escaping is performed.
 *
 * Caller is responsible for capping the hints array at 3 entries.
 */
export function buildPkbReminder(hints: ReadonlyArray<string>): string {
  if (hints.length === 0) {
    return `<system_reminder>${BODY}\n</system_reminder>`;
  }
  const bullets = hints.map((h) => `- ${h}`).join("\n");
  return `<system_reminder>${BODY}\nBased on the current context, these files look especially relevant:\n${bullets}\n</system_reminder>`;
}
