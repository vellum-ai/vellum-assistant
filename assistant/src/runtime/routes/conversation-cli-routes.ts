/**
 * CLI-specific route handlers for conversation operations.
 *
 * These routes serve the thin CLI wrappers — they return simple shapes
 * optimised for terminal output rather than the richer serialisations
 * used by the macOS / web clients.
 */

import { v4 as uuid } from "uuid";
import { z } from "zod";

import { clearAllConversations as clearAllActive } from "../../daemon/handlers/conversations.js";
import { formatJson, formatMarkdown } from "../../export/formatter.js";
import { ipcCall as ipcCallGateway } from "../../ipc/gateway-client.js";
import {
  addMessage,
  createConversation,
  getConversation,
  getMessages,
} from "../../memory/conversation-crud.js";
import { setConversationKey } from "../../memory/conversation-key-store.js";
import { listConversations } from "../../memory/conversation-queries.js";
import { getBindingByConversation } from "../../memory/external-conversation-store.js";
import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import { getLogger } from "../../util/logger.js";
import { BadGatewayError, BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversation-cli-routes");

// ---------------------------------------------------------------------------
// list (CLI)
// ---------------------------------------------------------------------------

function handleListCli({ body = {} }: RouteHandlerArgs) {
  const limit =
    body.limit != null ? Number(body.limit) : Number.MAX_SAFE_INTEGER;
  const includeArchived = (body.includeArchived as boolean) ?? false;

  const rows = listConversations(limit, false, 0, includeArchived);
  return {
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// create (CLI)
// ---------------------------------------------------------------------------

const seededConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

type SeededConversationMessage = z.infer<
  typeof seededConversationMessageSchema
>;

function textContentJson(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

async function handleCreateCli({ body = {} }: RouteHandlerArgs) {
  const title = body.title as string | undefined;
  const messages =
    (body.messages as SeededConversationMessage[] | undefined) ?? [];

  const conversation = createConversation(title);
  const conversationKey = uuid();
  setConversationKey(conversationKey, conversation.id);

  for (const message of messages) {
    await addMessage(
      conversation.id,
      message.role,
      textContentJson(message.content),
      undefined,
      { skipIndexing: true },
    );
  }

  return {
    id: conversation.id,
    title: conversation.title ?? "New Conversation",
    conversationKey,
    messagesInserted: messages.length,
  };
}

// ---------------------------------------------------------------------------
// export (CLI)
// ---------------------------------------------------------------------------

function handleExportCli({ body = {} }: RouteHandlerArgs) {
  const format = (body.format as string) ?? "md";
  if (format !== "md" && format !== "json") {
    throw new BadRequestError('format must be "md" or "json"');
  }

  let conversationId = body.conversationId as string | undefined;

  if (!conversationId) {
    const all = listConversations(1);
    if (all.length === 0) {
      throw new NotFoundError("No conversations found");
    }
    conversationId = all[0].id;
  }

  // Support prefix matching
  let conversation = getConversation(conversationId);
  if (!conversation) {
    const all = listConversations(Number.MAX_SAFE_INTEGER);
    const match = all.find((c) => c.id.startsWith(conversationId!));
    if (match) {
      conversation = match;
    } else {
      throw new NotFoundError(`Conversation not found: ${conversationId}`);
    }
  }

  const msgs = getMessages(conversation.id);
  const exportData = {
    ...conversation,
    messages: msgs.map((m) => ({
      role: m.role,
      content: JSON.parse(m.content),
      createdAt: m.createdAt,
    })),
  };

  const output =
    format === "json" ? formatJson(exportData) : formatMarkdown(exportData);

  return { output, conversationId: conversation.id };
}

// ---------------------------------------------------------------------------
// clear (CLI)
// ---------------------------------------------------------------------------

async function handleClearCli(_args: RouteHandlerArgs) {
  // Tear down in-memory conversation state before DB clear.
  const cleared = await clearAllActive();
  log.info(
    { cleared },
    "CLI conversations clear: active conversations torn down",
  );
  return { cleared };
}

// ---------------------------------------------------------------------------
// slack detach (CLI)
// ---------------------------------------------------------------------------

const slackDetachRequestSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
  channelId: z.string().trim().min(1).optional(),
  threadTs: z.string().trim().min(1).optional(),
});

const slackDetachResponseSchema = z.object({
  detached: z.boolean(),
  channelId: z.string(),
  threadTs: z.string(),
  source: z.enum(["explicit", "conversation_binding"]),
  conversationId: z.string().optional(),
});

type SlackDetachGatewayResponse = {
  detached: boolean;
  channelId: string;
  threadTs: string;
};

const SLACK_DETACH_CONFIRMATION_TEXT =
  "Muted this Slack thread. I won't respond to further replies here unless you mention me again.";

function isSlackDetachGatewayResponse(
  value: unknown,
): value is SlackDetachGatewayResponse {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as SlackDetachGatewayResponse).detached === "boolean" &&
    typeof (value as SlackDetachGatewayResponse).channelId === "string" &&
    typeof (value as SlackDetachGatewayResponse).threadTs === "string"
  );
}

async function handleSlackDetachCli({ body = {} }: RouteHandlerArgs) {
  const parsed = slackDetachRequestSchema.parse(body);
  const explicitChannelId = parsed.channelId;
  const explicitThreadTs = parsed.threadTs;

  let channelId: string;
  let threadTs: string;
  let source: "explicit" | "conversation_binding";
  let conversationId: string | undefined;

  if (explicitChannelId || explicitThreadTs) {
    if (!explicitChannelId || !explicitThreadTs) {
      throw new BadRequestError(
        "Both channelId and threadTs are required when detaching by explicit Slack identifiers",
      );
    }
    channelId = explicitChannelId;
    threadTs = explicitThreadTs;
    source = "explicit";
  } else {
    if (!parsed.conversationId) {
      throw new BadRequestError(
        "conversationId is required unless channelId and threadTs are provided",
      );
    }

    const binding = getBindingByConversation(parsed.conversationId);
    if (!binding) {
      throw new NotFoundError(
        `No channel binding found for conversation ${parsed.conversationId}`,
      );
    }
    if (binding.sourceChannel !== "slack") {
      throw new BadRequestError(
        `Conversation ${parsed.conversationId} is bound to ${binding.sourceChannel}, not Slack`,
      );
    }
    if (!binding.externalThreadId) {
      throw new BadRequestError(
        `Conversation ${parsed.conversationId} is not bound to a Slack thread`,
      );
    }

    channelId = binding.externalChatId;
    threadTs = binding.externalThreadId;
    source = "conversation_binding";
    conversationId = parsed.conversationId;
  }

  const gatewayResult = await ipcCallGateway(
    "detach_slack_active_thread",
    { channelId, threadTs },
    5_000,
  );
  if (!isSlackDetachGatewayResponse(gatewayResult)) {
    throw new BadGatewayError(
      "Could not detach Slack thread from assistant listening",
    );
  }

  if (gatewayResult.detached) {
    try {
      await sendSlackReply(
        gatewayResult.channelId,
        SLACK_DETACH_CONFIRMATION_TEXT,
        { threadTs: gatewayResult.threadTs },
      );
    } catch (err) {
      log.warn(
        {
          err,
          channelId: gatewayResult.channelId,
          threadTs: gatewayResult.threadTs,
        },
        "Slack thread detached, but confirmation message failed",
      );
      throw new BadGatewayError(
        "Detached Slack thread but could not send confirmation",
      );
    }
  }

  return {
    detached: gatewayResult.detached,
    channelId: gatewayResult.channelId,
    threadTs: gatewayResult.threadTs,
    source,
    ...(conversationId ? { conversationId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "conversation_list_cli",
    endpoint: "conversations/cli/list",
    method: "POST",
    summary: "List conversations (CLI)",
    description:
      "Simplified conversation list for CLI output — returns id, title, updatedAt.",
    tags: ["conversations"],
    requestBody: z.object({
      limit: z.number().int().positive().optional(),
      includeArchived: z.boolean().optional(),
    }),
    responseBody: z.object({
      conversations: z.array(
        z.object({
          id: z.string(),
          title: z.string().nullable(),
          updatedAt: z.number(),
        }),
      ),
    }),
    handler: handleListCli,
  },
  {
    operationId: "conversation_create_cli",
    endpoint: "conversations/cli/create",
    method: "POST",
    summary: "Create a conversation (CLI)",
    description:
      "Create a new conversation with an optional title and seeded messages.",
    tags: ["conversations"],
    requestBody: z.object({
      title: z.string().optional(),
      messages: z.array(seededConversationMessageSchema).optional(),
    }),
    responseBody: z.object({
      id: z.string(),
      title: z.string(),
      conversationKey: z.string(),
      messagesInserted: z.number().int().nonnegative(),
    }),
    handler: handleCreateCli,
  },
  {
    operationId: "conversation_export_cli",
    endpoint: "conversations/cli/export",
    method: "POST",
    summary: "Export a conversation (CLI)",
    description:
      "Export a conversation as markdown or JSON. Returns the formatted output string.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string().optional(),
      format: z.enum(["md", "json"]).default("md"),
    }),
    responseBody: z.object({
      output: z.string(),
      conversationId: z.string(),
    }),
    handler: handleExportCli,
  },
  {
    operationId: "conversations_clear_cli",
    endpoint: "conversations/cli/clear",
    method: "POST",
    summary: "Clear all conversations (CLI)",
    description:
      "Tear down all active conversations and clear the database. " +
      "The confirmation prompt is handled client-side by the CLI.",
    tags: ["conversations"],
    responseBody: z.object({
      cleared: z.number().int(),
    }),
    handler: handleClearCli,
  },
  {
    operationId: "conversation_slack_detach_cli",
    endpoint: "conversations/cli/slack/detach",
    method: "POST",
    summary: "Detach the assistant from a Slack thread (CLI)",
    description:
      "Stops Slack active-thread listening for a Slack thread. The CLI resolves current conversation defaults.",
    tags: ["conversations"],
    requestBody: slackDetachRequestSchema,
    responseBody: slackDetachResponseSchema,
    handler: handleSlackDetachCli,
  },
];
