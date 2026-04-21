/**
 * Playground-only list/delete endpoints for conversations seeded by the
 * seed-conversation route. Prefix-gated on the title (every seeded
 * conversation is titled `[Playground] ...`) so a flag-on caller cannot use
 * these routes to list or delete unrelated conversations.
 */

import { httpError } from "../../http-errors.js";
import type { RouteDefinition } from "../../http-router.js";
import { assertPlaygroundEnabled, type PlaygroundRouteDeps } from "./index.js";

/**
 * Title prefix every playground-seeded conversation starts with. PR 6
 * (seed-conversation) is expected to export this constant from
 * `./seed-conversation.ts`. Until PR 6 lands, declare it locally so this
 * file can be merged independently. On rebase, switch to the imported value
 * from `./seed-conversation.js` to avoid two sources of truth.
 */
export const PLAYGROUND_TITLE_PREFIX = "[Playground] ";

export function seededConversationsRouteDefinitions(
  deps: PlaygroundRouteDeps,
): RouteDefinition[] {
  return [
    {
      endpoint: "playground/seeded-conversations",
      method: "GET",
      policyKey: "playground/seeded-conversations/list",
      summary: "List conversations created by the seed-conversation endpoint",
      tags: ["playground"],
      handler: async () => {
        const gate = assertPlaygroundEnabled(deps);
        if (gate) return gate;
        const conversations = deps.listConversationsByTitlePrefix(
          PLAYGROUND_TITLE_PREFIX,
        );
        return Response.json({ conversations });
      },
    },
    {
      endpoint: "playground/seeded-conversations/:id",
      method: "DELETE",
      policyKey: "playground/seeded-conversations/delete-one",
      summary: "Delete a single seeded conversation (prefix-gated)",
      tags: ["playground"],
      handler: async ({ params }) => {
        const gate = assertPlaygroundEnabled(deps);
        if (gate) return gate;

        // The in-memory `Conversation` object does not carry the DB title,
        // and the seeded row may not be loaded into memory at all. Use the
        // prefix-filtered DB listing as the authoritative membership check
        // so we reject attempts to delete arbitrary conversations via this
        // endpoint even when the flag is on.
        const seeded = deps
          .listConversationsByTitlePrefix(PLAYGROUND_TITLE_PREFIX)
          .find((c) => c.id === params.id);
        if (!seeded) {
          return httpError("FORBIDDEN", "Not a playground conversation", 403);
        }

        const deleted = deps.deleteConversationById(params.id);
        return Response.json({ deletedCount: deleted ? 1 : 0 });
      },
    },
    {
      endpoint: "playground/seeded-conversations",
      method: "DELETE",
      policyKey: "playground/seeded-conversations/delete-all",
      summary: "Delete every seeded playground conversation (prefix-gated)",
      tags: ["playground"],
      handler: async () => {
        const gate = assertPlaygroundEnabled(deps);
        if (gate) return gate;
        const candidates = deps.listConversationsByTitlePrefix(
          PLAYGROUND_TITLE_PREFIX,
        );
        let deletedCount = 0;
        for (const c of candidates) {
          if (deps.deleteConversationById(c.id)) deletedCount++;
        }
        return Response.json({ deletedCount });
      },
    },
  ];
}
