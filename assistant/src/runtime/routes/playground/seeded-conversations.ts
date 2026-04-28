/**
 * Playground-only list/delete endpoints for conversations seeded by the
 * seed-conversation route. Prefix-gated on the title (every seeded
 * conversation is titled `[Playground] ...`) so a flag-on caller cannot use
 * these routes to list or delete unrelated conversations.
 */

import { ForbiddenError } from "../errors.js";
import type { RouteDefinition } from "../types.js";
import { assertPlaygroundEnabled } from "./guard.js";
import {
  deleteConversationById,
  listConversationsByTitlePrefix,
} from "./helpers.js";
import { PLAYGROUND_TITLE_PREFIX } from "./seed-conversation.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "playgroundListSeededConversations",
    endpoint: "playground/seeded-conversations",
    method: "GET",
    policyKey: "playground/seeded-conversations/list",
    summary: "List conversations created by the seed-conversation endpoint",
    tags: ["playground"],
    handler: () => {
      assertPlaygroundEnabled();
      const conversations = listConversationsByTitlePrefix(
        PLAYGROUND_TITLE_PREFIX,
      );
      return { conversations };
    },
  },
  {
    operationId: "playgroundDeleteSeededConversation",
    endpoint: "playground/seeded-conversations/:id",
    method: "DELETE",
    policyKey: "playground/seeded-conversations/delete-one",
    summary: "Delete a single seeded conversation (prefix-gated)",
    tags: ["playground"],
    pathParams: [{ name: "id", type: "uuid" }],
    handler: ({ pathParams }) => {
      assertPlaygroundEnabled();

      const id = pathParams!.id;
      const seeded = listConversationsByTitlePrefix(PLAYGROUND_TITLE_PREFIX)
        .find((c) => c.id === id);
      if (!seeded) {
        throw new ForbiddenError("Not a playground conversation");
      }

      const deleted = deleteConversationById(id);
      return { deletedCount: deleted ? 1 : 0 };
    },
  },
  {
    operationId: "playgroundDeleteAllSeededConversations",
    endpoint: "playground/seeded-conversations",
    method: "DELETE",
    policyKey: "playground/seeded-conversations/delete-all",
    summary: "Delete every seeded playground conversation (prefix-gated)",
    tags: ["playground"],
    handler: () => {
      assertPlaygroundEnabled();
      const candidates = listConversationsByTitlePrefix(
        PLAYGROUND_TITLE_PREFIX,
      );
      let deletedCount = 0;
      for (const c of candidates) {
        if (deleteConversationById(c.id)) deletedCount++;
      }
      return { deletedCount };
    },
  },
];
