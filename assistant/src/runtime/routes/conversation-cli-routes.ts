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
import { sendSlackReply } from "../../messaging/providers/slack/send.js";
import type { ConversationCreateType } from "../../persistence/conversation-crud.js";
import { isConversationProcessing } from "../../persistence/conversation-crud.js";
import {
  addMessage,
  createConversation,
  getConversation,
  getMessages,
} from "../../persistence/conversation-crud.js";
import { setConversationKey } from "../../persistence/conversation-key-store.js";
import { listConversations } from "../../persistence/conversation-queries.js";
import { getBindingByConversation } from "../../persistence/external-conversation-store.js";
import { getLogger } from "../../util/logger.js";
import { withSqliteRetry } from "../../util/sqlite-retry.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadGatewayError, BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversation-cli-routes");

// ---------------------------------------------------------------------------
// list (CLI)
// ---------------------------------------------------------------------------

function handleListCli({ body = {} }: RouteHandlerArgs) {
  const limit =
    body.limit != null ? Number(body.limit) : Number.MAX_SAFE_INTEGER;
  // CLI flag historically named `includeArchived`. Map onto the new
  // `archiveStatus` enum: when set, fetch active + archived together so the
  // user sees archived rows alongside live ones in the picker.
  const includeArchived = (body.includeArchived as boolean) ?? false;

  const rows = listConversations(
    limit,
    "standard",
    0,
    includeArchived ? "all" : "active",
  );
  return {
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      // Checks in-memory flag first (hot path), falls back to the
      // persisted `processing_started_at` column for cold conversations.
      isProcessing: isConversationProcessing(c.id),
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

const conversationCreateTypeSchema = z.enum([
  "standard",
  "background",
  "scheduled",
]);

function textContentJson(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

async function handleCreateCli({ body = {} }: RouteHandlerArgs) {
  const title = body.title as string | undefined;
  const messages =
    (body.messages as SeededConversationMessage[] | undefined) ?? [];

  let conversationType: ConversationCreateType | undefined;
  if (body.conversationType !== undefined) {
    const parsed = conversationCreateTypeSchema.safeParse(
      body.conversationType,
    );
    if (!parsed.success) {
      throw new BadRequestError(
        `Invalid conversationType: must be one of ${conversationCreateTypeSchema.options.join(", ")}`,
      );
    }
    conversationType = parsed.data;
  }

  const conversation = await withSqliteRetry(
    () => createConversation({ title, conversationType }),
    { op: "createConversationCli" },
  );
  const conversationKey = uuid();
  setConversationKey(conversationKey, conversation.id);

  for (const message of messages) {
    await addMessage(
      conversation.id,
      message.role,
      textContentJson(message.content),
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

  // Support prefix matching. `archiveStatus: "all"` preserves the pre-default
  // behavior of letting `vellum export <prefix>` resolve an archived row.
  let conversation = getConversation(conversationId);
  if (!conversation) {
    const all = listConversations(
      Number.MAX_SAFE_INTEGER,
      "standard",
      0,
      "all",
    );
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

async function handleClearCli({ headers = {} }: RouteHandlerArgs) {
  const confirm = headers["x-confirm-destructive"];
  if (confirm !== "clear-all-conversations") {
    throw new BadRequestError(
      "POST /v1/conversations/cli/clear permanently deletes ALL conversations, messages, and memory. " +
        "To confirm, set header X-Confirm-Destructive: clear-all-conversations",
    );
  }

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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
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
          isProcessing: z.boolean(),
        }),
      ),
    }),
    handler: handleListCli,
  },
  {
    operationId: "conversation_create_cli",
    endpoint: "conversations/cli/create",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Create a conversation (CLI)",
    description:
      "Create a new conversation with an optional title and seeded messages.",
    tags: ["conversations"],
    requestBody: z.object({
      title: z.string().optional(),
      messages: z.array(seededConversationMessageSchema).optional(),
      conversationType: conversationCreateTypeSchema.optional(),
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Clear all conversations (CLI)",
    description:
      "Tear down all active conversations and clear the database. " +
      "Requires X-Confirm-Destructive: clear-all-conversations.",
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Detach the assistant from a Slack thread (CLI)",
    description:
      "Stops Slack active-thread listening for a Slack thread. The CLI resolves current conversation defaults.",
    tags: ["conversations"],
    requestBody: slackDetachRequestSchema,
    responseBody: slackDetachResponseSchema,
    handler: handleSlackDetachCli,
  },
];
