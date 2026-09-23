/**
 * A trusted contact's read routes for the conversations shared with them.
 *
 * GET /v1/shared/conversations
 * GET /v1/shared/conversations/:id
 * GET /v1/shared/conversations/:id/messages
 *
 * Every route resolves the caller's membership before anything else and
 * answers 404 when it is missing, so a contact cannot tell a conversation
 * they were not given from one that does not exist. Conversation metadata
 * is an explicit allowlist, and every message passes through the contact
 * projection, which drops reasoning, tool traffic and anything else a
 * contact may not read. The guardian reads through their own routes and is
 * refused here.
 */

import { z } from "zod";

import {
  type ContactReader,
  type ContactVisibleBlock,
  projectRowForContact,
} from "../../persistence/contact-visible-content.js";
import {
  type ConversationRow,
  getConversation,
  getMessagesPaginated,
  type MessageRow,
} from "../../persistence/conversation-crud.js";
import {
  isParticipant,
  listConversationIdsForPrincipal,
} from "../../persistence/conversation-participants.js";
import {
  type RoutePolicy,
  TRUSTED_CONTACT_ONLY,
} from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 500;

export const POLICY: RoutePolicy = {
  requiredScopes: ["shared.read"],
  allowedPrincipalTypes: ["actor"],
  allowedTrustClasses: TRUSTED_CONTACT_ONLY,
};

const sharedConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastMessageAt: z.number().nullable(),
});

const workspaceRefSchema = z.object({
  type: z.literal("workspace_ref"),
  media_type: z.string(),
  attachmentId: z.string(),
  sizeBytes: z.number(),
  filename: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const contactVisibleBlockSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
    _redactionVersion: z.number().optional(),
  }),
  z.object({
    type: z.enum(["image", "file"]),
    source: workspaceRefSchema,
  }),
]);

const sharedMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  createdAt: z.number(),
  content: z.array(contactVisibleBlockSchema),
});

function serializeConversation(conversation: ConversationRow) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
  };
}

/**
 * The caller's principal. Trust enforcement has already required one, so a
 * request without it is refused as if the route did not exist.
 */
export function readerFrom(
  headers: RouteHandlerArgs["headers"],
): ContactReader {
  const principalId = headers?.["x-vellum-actor-principal-id"]?.trim();
  if (!principalId) {
    throw new NotFoundError("Not found");
  }
  return { principalId };
}

/** The conversation, when the reader is one of its live participants. */
function sharedConversationOrThrow(
  conversationId: string,
  reader: ContactReader,
): ConversationRow {
  const conversation = isParticipant(conversationId, reader.principalId)
    ? getConversation(conversationId)
    : null;
  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }
  return conversation;
}

function parseOptionalNumber(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) {
    throw new BadRequestError(`${name} must be a valid number`);
  }
  return value;
}

function handleListSharedConversations({ headers }: RouteHandlerArgs) {
  const reader = readerFrom(headers);
  const conversations = listConversationIdsForPrincipal(reader.principalId)
    .map((id) => getConversation(id))
    .filter((row): row is ConversationRow => row !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return { conversations: conversations.map(serializeConversation) };
}

function handleGetSharedConversation({
  pathParams = {},
  headers,
}: RouteHandlerArgs) {
  const reader = readerFrom(headers);
  const conversation = sharedConversationOrThrow(pathParams.id!, reader);
  return { conversation: serializeConversation(conversation) };
}

function handleListSharedMessages({
  pathParams = {},
  queryParams = {},
  headers,
}: RouteHandlerArgs) {
  const reader = readerFrom(headers);
  const { id: conversationId } = sharedConversationOrThrow(
    pathParams.id!,
    reader,
  );

  const beforeTimestamp = parseOptionalNumber(
    queryParams.beforeTimestamp,
    "beforeTimestamp",
  );
  const requestedLimit = parseOptionalNumber(queryParams.limit, "limit");
  const limit =
    requestedLimit === undefined
      ? DEFAULT_MESSAGE_LIMIT
      : Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_MESSAGE_LIMIT);

  // The projection is the page filter, so a row that projects to nothing
  // never counts toward the page and `hasMore` describes visible rows.
  const projected = new Map<string, ContactVisibleBlock[]>();
  const visible = (row: MessageRow): boolean => {
    const content = projectRowForContact(row, reader);
    if (content.length === 0) {
      return false;
    }
    projected.set(row.id, content);
    return true;
  };

  const page = getMessagesPaginated(
    conversationId,
    limit,
    beforeTimestamp,
    visible,
  );
  // A scan that stopped on its row cap can return an empty page; its cursor
  // still lets the client ask for the next older window. The cursor's row id
  // is not returned, since that row may be one the contact cannot read.
  const oldest = page.messages[0];

  return {
    messages: page.messages.map((row) => ({
      id: row.id,
      role: row.role as "user" | "assistant",
      createdAt: row.createdAt,
      content: projected.get(row.id)!,
    })),
    hasMore: page.hasMore,
    oldestTimestamp: oldest?.createdAt ?? page.nextCursor?.createdAt ?? null,
    oldestMessageId: oldest?.id ?? null,
  };
}

const conversationIdParam = { name: "id", type: "uuid" } as const;
const notFound = {
  "404": {
    description: "Conversation not found or not shared with the caller",
  },
};

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listSharedConversations",
    endpoint: "shared/conversations",
    method: "GET",
    policy: POLICY,
    summary: "List conversations shared with the caller",
    description:
      "List the conversations the calling contact is a participant of, most recently updated first.",
    tags: ["shared"],
    responseBody: z.object({
      conversations: z.array(sharedConversationSchema),
    }),
    handler: handleListSharedConversations,
  },
  {
    operationId: "getSharedConversation",
    endpoint: "shared/conversations/:id",
    method: "GET",
    policy: POLICY,
    summary: "Get a shared conversation",
    description:
      "Return the metadata of a conversation shared with the calling contact.",
    tags: ["shared"],
    pathParams: [conversationIdParam],
    responseBody: z.object({ conversation: sharedConversationSchema }),
    additionalResponses: notFound,
    handler: handleGetSharedConversation,
  },
  {
    operationId: "listSharedConversationMessages",
    endpoint: "shared/conversations/:id/messages",
    method: "GET",
    policy: POLICY,
    summary: "List messages in a shared conversation",
    description:
      "Return the newest page of messages a contact may read in a conversation shared with them, oldest first. " +
      "Reasoning, tool calls and results, and messages addressed to someone else are never included.",
    tags: ["shared"],
    pathParams: [conversationIdParam],
    queryParams: [
      {
        name: "beforeTimestamp",
        type: "integer",
        required: false,
        description:
          "Return messages older than this timestamp (ms since epoch). Used for paging older history.",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        description: `Maximum number of messages to return, 1 to ${MAX_MESSAGE_LIMIT}. Defaults to ${DEFAULT_MESSAGE_LIMIT}.`,
      },
    ],
    responseBody: z.object({
      messages: z.array(sharedMessageSchema),
      hasMore: z
        .boolean()
        .describe("Whether older messages exist beyond this page"),
      oldestTimestamp: z
        .number()
        .nullable()
        .describe(
          "Timestamp to pass as beforeTimestamp for the next older page. Null when there is none.",
        ),
      oldestMessageId: z
        .string()
        .nullable()
        .describe("ID of the oldest message in this page"),
    }),
    additionalResponses: {
      ...notFound,
      "400": { description: "A query parameter is not a valid number" },
    },
    handler: handleListSharedMessages,
  },
];
