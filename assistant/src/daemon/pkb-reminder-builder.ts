const BODY_DEFAULT =
  "\n**CRITICAL:** Call `remember` this turn for anything concrete the user said — facts, preferences, plans, names, dates, decisions, corrections, felt moments. Default to remembering; skip only obvious noise. This should be your most frequently used tool." +
  "\nIf you're unsure about something that may live in the workspace — past decisions, prior conversations, files — use `recall` before asking or guessing.";

const BODY_RELAXED =
  "\nStay present in this conversation. Use `remember` when something feels worth pausing to mark — corrections (highest priority), plans, decisions, felt moments, things the user asks you to hold onto. You don't have to capture everything in the moment — a retrospective pass reviews this conversation in the background and saves what you didn't capture." +
  "\nIf you're unsure about something that may live in the workspace — past decisions, prior conversations, files — use `recall` before asking or guessing.";

/**
 * Render the PKB system_reminder text, optionally with a bulleted list of
 * hint paths that look especially relevant to the current conversation.
 *
 * When `hints` is empty, returns the base reminder byte-for-byte.
 * When `hints` is non-empty, renders an extended reminder with a bullet per
 * hint. Hints are emitted verbatim — they are trusted internal paths, not
 * user input, so no escaping is performed.
 *
 * The `relaxed` flag selects between the default high-pressure body and the
 * relaxed "judgment framing" body used when the `memory-retrospective`
 * feature flag is on. With the flag on, the in-conversation remember pressure
 * eases because the retrospective is the backstop. Callers must pass
 * `relaxed` explicitly — no default — so the contract is visible at every
 * call site.
 *
 * Caller is responsible for capping the hints array at 3 entries.
 */
export function buildPkbReminder(
  hints: ReadonlyArray<string>,
  relaxed: boolean,
): string {
  const body = relaxed ? BODY_RELAXED : BODY_DEFAULT;
  if (hints.length === 0) {
    return `<system_reminder>${body}\n</system_reminder>`;
  }
  const bullets = hints.map((h) => `- ${h}`).join("\n");
  return `<system_reminder>${body}\nBased on the current context, these files look especially relevant:\n${bullets}\n</system_reminder>`;
}
