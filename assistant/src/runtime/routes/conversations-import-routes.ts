import { eq } from "drizzle-orm";
import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import {
  addMessage,
  createConversation,
  type MessageRole,
} from "../../memory/conversation-crud.js";
import {
  getConversationByKey,
  setConversationKey,
} from "../../memory/conversation-key-store.js";
import { getDb } from "../../memory/db-connection.js";
import { indexMessageNow } from "../../memory/indexer.js";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversations-import-routes");

// -- Types --

interface ImportMessage {
  role: MessageRole;
  content: string | Array<{ type: string; text: string }>;
  createdAt?: number;
}

interface ImportConversation {
  sourceKey?: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ImportMessage[];
}

interface ImportPayload {
  conversations: ImportConversation[];
}

// -- Helpers (ported from CLI) --

function resolveTimestamps(
  conv: ImportConversation,
  messages: ImportMessage[],
): {
  convCreatedAt: number;
  convUpdatedAt: number;
  messageTimestamps: number[];
} {
  const now = Date.now();
  const convCreatedAt = conv.createdAt ?? now;
  const convUpdatedAt = conv.updatedAt ?? conv.createdAt ?? now;
  const messageTimestamps = messages.map((msg, i) => {
    if (msg.createdAt != null) return msg.createdAt;
    return convCreatedAt + i;
  });
  return { convCreatedAt, convUpdatedAt, messageTimestamps };
}

/**
 * The messages store is UI-facing (`ConversationMessage`), so only renderable
 * turns are persisted. Non-renderable roles (e.g. agent-context `system`
 * rows an export might carry) are dropped here rather than imported — the
 * import still succeeds with the displayable turns.
 */
function isRenderableRole(role: string): role is "user" | "assistant" {
  return role === "user" || role === "assistant";
}

// -- Handler --

async function handleConversationsImport({ body }: RouteHandlerArgs) {
  if (
    !body ||
    !Array.isArray((body as Record<string, unknown>).conversations)
  ) {
    throw new BadRequestError("conversations array required");
  }

  const payload = body as unknown as ImportPayload;
  const db = getDb();
  const memoryConfig = getConfig().memory;

  let imported = 0;
  let skipped = 0;
  let totalMessages = 0;
  const errors: Array<{ index: number; sourceKey?: string; error: string }> =
    [];

  for (let idx = 0; idx < payload.conversations.length; idx++) {
    const conv = payload.conversations[idx];

    if (!conv || typeof conv !== "object") {
      errors.push({ index: idx, error: "invalid conversation entry" });
      continue;
    }

    try {
      // Dedup via sourceKey
      if (conv.sourceKey) {
        const existing = getConversationByKey(conv.sourceKey);
        if (existing) {
          skipped++;
          continue;
        }
      }

      const messages = conv.messages.filter((msg) =>
        isRenderableRole(msg.role),
      );

      const { convCreatedAt, convUpdatedAt, messageTimestamps } =
        resolveTimestamps(conv, messages);

      const conversation = createConversation(conv.title);

      for (const msg of messages) {
        const contentStr =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        await addMessage(conversation.id, msg.role, contentStr, {
          skipIndexing: true,
        });
      }

      // Override conversation timestamps
      db.update(conversationsTable)
        .set({
          createdAt: convCreatedAt,
          updatedAt: convUpdatedAt,
          lastMessageAt: messageTimestamps[messageTimestamps.length - 1],
        })
        .where(eq(conversationsTable.id, conversation.id))
        .run();

      // Override message timestamps
      const dbMessages = db
        .select({ id: messagesTable.id })
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, conversation.id))
        .orderBy(messagesTable.createdAt)
        .all();

      for (
        let i = 0;
        i < dbMessages.length && i < messageTimestamps.length;
        i++
      ) {
        db.update(messagesTable)
          .set({ createdAt: messageTimestamps[i] })
          .where(eq(messagesTable.id, dbMessages[i].id))
          .run();
      }

      // Index messages
      for (let i = 0; i < dbMessages.length && i < messages.length; i++) {
        const msg = messages[i];
        const contentStr =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        try {
          await indexMessageNow(
            {
              messageId: dbMessages[i].id,
              conversationId: conversation.id,
              role: msg.role,
              content: contentStr,
              createdAt: messageTimestamps[i],
            },
            memoryConfig,
          );
        } catch (err) {
          log.warn(
            "Failed to index imported message %s in conversation %s: %s",
            dbMessages[i].id,
            conversation.id,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (conv.sourceKey) {
        setConversationKey(conv.sourceKey, conversation.id);
      }

      imported++;
      totalMessages += messages.length;
    } catch (err) {
      errors.push({
        index: idx,
        sourceKey: conv.sourceKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: errors.length === 0,
    imported,
    skipped,
    messages: totalMessages,
    errors,
  };
}

// -- Routes --

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "conversations_import",
    endpoint: "conversations/import",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleConversationsImport,
    summary: "Import conversations",
    description: "Import conversations from a standard JSON payload.",
    tags: ["conversations"],
    requestBody: z.object({
      conversations: z.array(
        z.object({
          sourceKey: z.string().optional(),
          title: z.string(),
          createdAt: z.number().optional(),
          updatedAt: z.number().optional(),
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.union([
                z.string(),
                z.array(z.object({ type: z.string(), text: z.string() })),
              ]),
              createdAt: z.number().optional(),
            }),
          ),
        }),
      ),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      imported: z.number(),
      skipped: z.number(),
      messages: z.number(),
      errors: z.array(
        z.object({
          index: z.number(),
          sourceKey: z.string().optional(),
          error: z.string(),
        }),
      ),
    }),
  },
];
