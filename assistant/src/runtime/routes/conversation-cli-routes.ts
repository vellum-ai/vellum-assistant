/**
 * CLI-specific route handlers for conversation operations.
 *
 * These routes serve the thin CLI wrappers — they return simple shapes
 * optimised for terminal output rather than the richer serialisations
 * used by the macOS / web clients.
 */

import { z } from "zod";

import { clearAllConversations as clearAllActive } from "../../daemon/handlers/conversations.js";
import { formatJson, formatMarkdown } from "../../export/formatter.js";
import {
  createConversation,
  getConversation,
  getMessages,
} from "../../memory/conversation-crud.js";
import { listConversations } from "../../memory/conversation-queries.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, NotFoundError } from "./errors.js";
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

function handleCreateCli({ body = {} }: RouteHandlerArgs) {
  const title = body.title as string | undefined;
  const conversation = createConversation(title);
  return {
    id: conversation.id,
    title: conversation.title ?? "New Conversation",
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
  const cleared = clearAllActive();
  log.info({ cleared }, "CLI conversations clear: active conversations torn down");
  return { cleared };
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
    description: "Create a new conversation with an optional title.",
    tags: ["conversations"],
    requestBody: z.object({
      title: z.string().optional(),
    }),
    responseBody: z.object({
      id: z.string(),
      title: z.string(),
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
];
