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
    return (
      "<system_reminder>" +
      "\nRead any unread Personal Knowledge Base files that might be even partially relevant to this conversation" +
      "\nUse `remember` for anything you learn immediately" +
      "\nIf you're unsure about something that may have an answer in your workspace, use `recall` to try to find it before asking or making assumptions" +
      "\n</system_reminder>"
    );
  }

  const bullets = hints.map((h) => `- ${h}`).join("\n");
  return (
    "<system_reminder>" +
    "\nRead any unread Personal Knowledge Base files that might be even partially relevant to this conversation." +
    "\nBased on the current context, these files look especially relevant:" +
    `\n${bullets}` +
    "\nUse `remember` for anything you learn immediately" +
    "\nIf you're unsure about something that may have an answer in your workspace, use `recall` to try to find it before asking or making assumptions" +
    "\n</system_reminder>"
  );
}
