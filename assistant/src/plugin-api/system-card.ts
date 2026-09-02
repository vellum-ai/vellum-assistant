/**
 * Plugin-facing facade over the host's system-card writer: a daemon-authored
 * transcript notice, persisted as an assistant row stamped
 * `messageKind: "system_card"` so clients render it as a standalone system
 * notice rather than assistant-persona speech. Plugins use it to tell the user
 * about something the turn did to their input that the model's own reply
 * cannot explain (e.g. an attachment the turn could not send).
 *
 * The writer is loaded through a dynamic `import()` inside the wrapper, for the
 * same reason `persistence/conversation-plugin-facade.ts` does: it carries the
 * DB/drizzle import graph, whose named exports must not be forced to resolve
 * merely because a plugin imported `@vellumai/plugin-api`. Suites that
 * partial-mock a module in that graph would otherwise fail to instantiate.
 */

/**
 * Persist a system card in a conversation's transcript and announce it to
 * connected clients through the sync invalidation that drives a refetch.
 * Returns the persisted message id.
 *
 * A plugin card is non-terminal: it never emits `message_complete`, so a card
 * written from a hook that runs inside a turn leaves that turn's streaming and
 * processing state untouched. It is also not appended to the conversation's
 * in-memory working history, so it cannot leave a trailing assistant message
 * for the turn's next provider call to continue from.
 */
export async function persistSystemCard(opts: {
  conversationId: string;
  text: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const { persistSystemCard: persistHostSystemCard } =
    await import("../runtime/routes/canned-message-complete.js");
  const { id } = await persistHostSystemCard({ ...opts, endsTurn: false });
  return id;
}
