/**
 * Skill IPC routes for the `host.history.*` facet.
 *
 * These mirror the in-process delegates an out-of-process skill would reach via
 * `host.history.*` (see {@link buildHistoryFacet}). Every handler is a thin
 * pass-through to the shared facet builder, with schema-validated params and a
 * serializable return shape. The facet applies the same trust/visibility
 * filtering the UI-facing history loads use (hidden rows and non-`user`/
 * `assistant` roles are dropped), so the IPC surface inherits it for free.
 */

import { z } from "zod";

import { buildHistoryFacet } from "../../daemon/skill-host-facets.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";

// -- Param schemas --------------------------------------------------------

const HistoryGetConversationParams = z.object({
  conversationId: z.string().min(1),
});

const HistoryGetRecentMessagesParams = z.object({
  conversationId: z.string().min(1),
  n: z.number().int(),
});

const HistoryGetMessagesParams = z.object({
  conversationId: z.string().min(1),
  limit: z.number().int().optional(),
  beforeTimestamp: z.number().optional(),
});

// -- Handlers -------------------------------------------------------------

async function handleGetConversation(params?: Record<string, unknown>) {
  const { conversationId } = HistoryGetConversationParams.parse(params);
  return buildHistoryFacet().getConversation(conversationId);
}

async function handleGetRecentMessages(params?: Record<string, unknown>) {
  const { conversationId, n } = HistoryGetRecentMessagesParams.parse(params);
  return buildHistoryFacet().getRecentMessages(conversationId, n);
}

async function handleGetMessages(params?: Record<string, unknown>) {
  const { conversationId, limit, beforeTimestamp } =
    HistoryGetMessagesParams.parse(params);
  return buildHistoryFacet().getMessages(conversationId, {
    limit,
    beforeTimestamp,
  });
}

// -- Route definitions ----------------------------------------------------

export const historyGetConversationRoute: SkillIpcRoute = {
  method: "host.history.getConversation",
  handler: handleGetConversation,
};

export const historyGetRecentMessagesRoute: SkillIpcRoute = {
  method: "host.history.getRecentMessages",
  handler: handleGetRecentMessages,
};

export const historyGetMessagesRoute: SkillIpcRoute = {
  method: "host.history.getMessages",
  handler: handleGetMessages,
};

/** All `host.history.*` IPC routes. */
export const historySkillRoutes: SkillIpcRoute[] = [
  historyGetConversationRoute,
  historyGetRecentMessagesRoute,
  historyGetMessagesRoute,
];
