/**
 * Route handlers for message bookmarks.
 *
 * GET    /v1/bookmarks                      — list all bookmarks (newest first)
 * POST   /v1/bookmarks                      — bookmark a message (idempotent)
 * DELETE /v1/bookmarks/by-message/:messageId — remove the bookmark for a given message
 *
 * Mutating routes publish `bookmark.created` / `bookmark.deleted` events
 * via `assistantEventHub` so any other connected client (e.g. a second
 * macOS window) can refresh its `BookmarkStore` in lock-step.
 */

import { z } from "zod";

import {
  type BookmarkSummary,
  createBookmark,
  deleteBookmarkByMessageId,
  listBookmarks,
} from "../../memory/bookmark-crud.js";
import { getMessageById } from "../../memory/conversation-crud.js";
import { getDb } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("bookmark-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publishBookmarkCreated(bookmark: BookmarkSummary): void {
  assistantEventHub
    .publish(buildAssistantEvent({ type: "bookmark.created", bookmark }))
    .catch((err) => {
      log.warn({ err }, "Failed to publish bookmark.created");
    });
}

function publishBookmarkDeleted(payload: {
  id?: string;
  messageId?: string;
}): void {
  assistantEventHub
    .publish(buildAssistantEvent({ type: "bookmark.deleted", ...payload }))
    .catch((err) => {
      log.warn({ err }, "Failed to publish bookmark.deleted");
    });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListBookmarks(): { bookmarks: BookmarkSummary[] } {
  return { bookmarks: listBookmarks(getDb()) };
}

function handleCreateBookmark({
  body = {},
}: RouteHandlerArgs): BookmarkSummary {
  const messageId = body.messageId as string | undefined;
  const conversationId = body.conversationId as string | undefined;

  if (!messageId || typeof messageId !== "string") {
    throw new BadRequestError("messageId is required");
  }
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  // Validate the message belongs to the named conversation up-front. The FK
  // constraints would also reject a bad insert, but explicit validation
  // keeps the idempotent path from returning a previously-bookmarked row
  // that happens to live under a different conversation id.
  if (!getMessageById(messageId, conversationId)) {
    throw new NotFoundError(
      `Message ${messageId} not found in conversation ${conversationId}`,
    );
  }

  const summary = createBookmark(getDb(), { messageId, conversationId });
  publishBookmarkCreated(summary);
  return summary;
}

function handleDeleteBookmarkByMessage({ pathParams = {} }: RouteHandlerArgs): {
  success: true;
} {
  const messageId = pathParams.messageId;
  if (!messageId) {
    throw new BadRequestError("messageId is required");
  }
  const removed = deleteBookmarkByMessageId(getDb(), messageId);
  if (removed) {
    publishBookmarkDeleted({ messageId });
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const bookmarkSummarySchema = z.object({
  id: z.string(),
  messageId: z.string(),
  conversationId: z.string(),
  conversationTitle: z.string().nullable(),
  messagePreview: z.string(),
  messageRole: z.string(),
  messageCreatedAt: z.number(),
  createdAt: z.number(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "bookmarks_list",
    endpoint: "bookmarks",
    method: "GET",
    summary: "List bookmarks",
    description:
      "Return all bookmarks (newest first), joined with their parent message and conversation.",
    tags: ["bookmarks"],
    responseBody: z.object({ bookmarks: z.array(bookmarkSummarySchema) }),
    handler: handleListBookmarks,
  },
  {
    operationId: "bookmarks_create",
    endpoint: "bookmarks",
    method: "POST",
    summary: "Create a bookmark",
    description:
      "Bookmark the given message. Idempotent on `messageId` — calling twice returns the same bookmark.",
    tags: ["bookmarks"],
    requestBody: z.object({
      messageId: z.string(),
      conversationId: z.string(),
    }),
    responseBody: bookmarkSummarySchema,
    handler: handleCreateBookmark,
  },
  {
    operationId: "bookmarks_delete_by_message",
    endpoint: "bookmarks/by-message/:messageId",
    method: "DELETE",
    summary: "Delete a bookmark by message id",
    description:
      "Delete the bookmark (if any) attached to the given message. Succeeds even if no row matched.",
    tags: ["bookmarks"],
    responseBody: z.object({ success: z.literal(true) }),
    handler: handleDeleteBookmarkByMessage,
  },
];
