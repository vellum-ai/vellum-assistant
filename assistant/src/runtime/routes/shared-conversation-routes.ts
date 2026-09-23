/**
 * A trusted contact's routes for the conversations shared with them.
 *
 * GET  /v1/shared/conversations
 * GET  /v1/shared/conversations/:id
 * GET  /v1/shared/conversations/:id/messages
 * POST /v1/shared/conversations/:id/messages
 *
 * Every route resolves the caller's membership before anything else and
 * answers 404 when it is missing, so a contact cannot tell a conversation
 * they were not given from one that does not exist. Conversation metadata
 * is an explicit allowlist, and every message passes through the contact
 * projection, which drops reasoning, tool traffic and anything else a
 * contact may not read. A contact's message runs a turn as that contact on
 * the `vellum-shared` channel, in a conversation that already exists. The
 * guardian uses their own routes and is refused here.
 */

import { z } from "zod";

import { isConversationBusyError } from "../../daemon/conversation-messaging.js";
import { processMessageInBackground } from "../../daemon/process-message.js";
import type { TrustContext } from "../../daemon/trust-context-types.js";
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
  PluginTurnNotAdmittedError,
  resolvePluginChannelTurnTrust,
} from "../../plugin-api/plugin-channel-turn-trust.js";
import { getLogger } from "../../util/logger.js";
import {
  type RoutePolicy,
  TRUSTED_CONTACT_ONLY,
} from "../auth/route-policy.js";
import { resolveRoutingState } from "../trust-context-resolver.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { withChannelTurnAdmission } from "./inbound-stages/channel-turn-admission.js";
import { prepareChannelInboundContent } from "./inbound-stages/inbound-content-prep.js";
import { secretBlockedResponse } from "./secret-blocked-response.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("shared-conversation-routes");

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 500;

/**
 * How many times a contact's turn goes back to wait when another turn claims
 * the conversation between admission and the turn taking it.
 */
const MAX_TURN_START_ATTEMPTS = 3;

const POLICY: RoutePolicy = {
  requiredScopes: ["shared.read"],
  allowedPrincipalTypes: ["actor"],
  allowedTrustClasses: TRUSTED_CONTACT_ONLY,
};

const WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["chat.write"],
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
function readerFrom(headers: RouteHandlerArgs["headers"]): ContactReader {
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

/**
 * The contact's own trust on the `vellum-shared` channel, read fresh from the
 * gateway with the channel's admission floor applied. Anything short of an
 * admitted trusted contact is refused as if the conversation did not exist.
 */
async function contactTurnTrust(reader: ContactReader): Promise<TrustContext> {
  let trust: TrustContext;
  try {
    trust = await resolvePluginChannelTurnTrust({
      sourceChannel: "vellum-shared",
      externalChatId: reader.principalId,
      externalUserId: reader.principalId,
    });
  } catch (err) {
    if (err instanceof PluginTurnNotAdmittedError) {
      throw new NotFoundError("Conversation not found");
    }
    throw err;
  }
  if (trust.trustClass !== "trusted_contact") {
    throw new NotFoundError("Conversation not found");
  }
  return trust;
}

type SharedTurnOptions = NonNullable<
  Parameters<typeof processMessageInBackground>[2]
>;

/**
 * Run the contact's turn once the conversation is free, behind any turn
 * already in flight. A contact removed while it waited is not run at all.
 */
async function runSharedTurn(
  conversationId: string,
  principalId: string,
  content: string,
  options: SharedTurnOptions,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await withChannelTurnAdmission(conversationId, async () => {
        if (!isParticipant(conversationId, principalId)) {
          log.info(
            { conversationId, principalId },
            "Shared turn dropped: the sender is no longer a participant",
          );
          return;
        }
        await processMessageInBackground(conversationId, content, options);
      });
      return;
    } catch (err) {
      if (!isConversationBusyError(err) || attempt >= MAX_TURN_START_ATTEMPTS) {
        throw err;
      }
    }
  }
}

async function handleSendSharedMessage({
  pathParams = {},
  body = {},
  headers,
}: RouteHandlerArgs) {
  const reader = readerFrom(headers);
  const { id: conversationId } = sharedConversationOrThrow(
    pathParams.id!,
    reader,
  );

  if (typeof body.content !== "string" || body.content.trim().length === 0) {
    throw new BadRequestError("content is required");
  }
  if (
    body.clientMessageId != null &&
    typeof body.clientMessageId !== "string"
  ) {
    throw new BadRequestError("clientMessageId must be a string");
  }
  const trimmedContent = body.content.trim();

  const trust = await contactTurnTrust(reader);

  const blocked = secretBlockedResponse(trimmedContent);
  if (blocked) {
    return blocked;
  }

  const prepared = prepareChannelInboundContent({
    trimmedContent,
    trustClass: trust.trustClass,
    sourceChannel: "vellum-shared",
    requesterIdentifier: trust.requesterIdentifier,
  });

  void runSharedTurn(conversationId, reader.principalId, prepared.content, {
    existingConversationOnly: true,
    sourceChannel: "vellum-shared",
    sourceInterface: "web",
    trustContext: trust,
    author: trust,
    sourceActorPrincipalId: reader.principalId,
    isInteractive: resolveRoutingState(trust).promptWaitingAllowed,
    ...(prepared.displayContent !== undefined
      ? { displayContent: prepared.displayContent }
      : {}),
    // Namespaced by sender, so a contact's retry deduplicates against their
    // own earlier send and never against a row someone else wrote.
    ...(body.clientMessageId
      ? {
          clientMessageId: `vellum-shared:${reader.principalId}:${body.clientMessageId}`,
        }
      : {}),
  }).catch((err) => {
    log.error(
      { err, conversationId, principalId: reader.principalId },
      "Shared conversation turn failed",
    );
  });

  return { accepted: true };
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
  {
    operationId: "sendSharedConversationMessage",
    endpoint: "shared/conversations/:id/messages",
    method: "POST",
    policy: WRITE_POLICY,
    summary: "Send a message to a shared conversation",
    description:
      "Send a message from the calling contact to a conversation shared with them. " +
      "The reply runs as that contact and streams to the conversation's readers. " +
      "The conversation must already exist; this never creates one.",
    tags: ["shared"],
    responseStatus: "202",
    pathParams: [conversationIdParam],
    requestBody: z.object({
      content: z.string().describe("Message text"),
      clientMessageId: z
        .string()
        .optional()
        .describe(
          "Client-generated idempotency nonce. A retry with the same value is accepted without running a second turn.",
        ),
    }),
    responseBody: z.object({ accepted: z.boolean() }),
    additionalResponses: {
      ...notFound,
      "400": { description: "The message has no content" },
      "422": { description: "The message contains a secret and was not sent" },
    },
    handler: handleSendSharedMessage,
  },
];
