/**
 * HTTP route: read tallies over the plugin's reserved namespace.
 *
 *   GET /x/plugins/turn-tally/tally                      -> every tally
 *   GET /x/plugins/turn-tally/tally?conversationId=<id>  -> one tally (404 when unknown)
 *
 * Route files are re-imported by the dispatcher with a cache-busting URL,
 * so this module cannot share the hooks' in-memory handle; the store
 * lazily opens the same SQLite file from the plugin's data directory.
 */

import { getTally, listTallies } from "../src/tally-store.js";

export async function GET(request: Request): Promise<Response> {
  const conversationId = new URL(request.url).searchParams.get(
    "conversationId",
  );
  if (conversationId !== null) {
    const tally = getTally(conversationId);
    if (tally === null) {
      return Response.json(
        { error: `no tally recorded for conversation ${conversationId}` },
        { status: 404 },
      );
    }
    return Response.json(tally);
  }
  return Response.json({ tallies: listTallies() });
}
