import { existsSync, readFileSync } from "node:fs";

import type { Command } from "commander";
import { eq } from "drizzle-orm";

import { getConfig } from "../../config/loader.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import {
  getConversationByKey,
  setConversationKey,
} from "../../memory/conversation-key-store.js";
import { getDb } from "../../memory/db.js";
import { indexMessageNow } from "../../memory/indexer.js";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import { log } from "../logger.js";

const importLog = getLogger("conversations-import");

// -- Import payload schema --

interface ImportMessage {
  role: string;
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

interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  messages: number;
  errors: Array<{
    index: number;
    sourceKey?: string;
    error: string;
  }>;
}

// -- Validation --

function validatePayload(raw: unknown): ImportPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Input must be a JSON object with a 'conversations' array");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.conversations)) {
    throw new Error("Input must have a 'conversations' array");
  }
  for (let i = 0; i < obj.conversations.length; i++) {
    const conv = obj.conversations[i] as Record<string, unknown>;
    if (!conv.title || typeof conv.title !== "string") {
      throw new Error(
        `conversations[${i}].title is required and must be a string`,
      );
    }
    if (!Array.isArray(conv.messages) || conv.messages.length === 0) {
      throw new Error(`conversations[${i}].messages must be a non-empty array`);
    }
    for (let j = 0; j < (conv.messages as unknown[]).length; j++) {
      const msg = (conv.messages as Array<Record<string, unknown>>)[j];
      if (!msg.role || typeof msg.role !== "string") {
        throw new Error(`conversations[${i}].messages[${j}].role is required`);
      }
      if (msg.content === undefined || msg.content === null) {
        throw new Error(
          `conversations[${i}].messages[${j}].content is required`,
        );
      }
    }
  }
  return obj as unknown as ImportPayload;
}

// -- Timestamp resolution --

function resolveTimestamps(conv: ImportConversation): {
  convCreatedAt: number;
  convUpdatedAt: number;
  messageTimestamps: number[];
} {
  const now = Date.now();
  const convCreatedAt = conv.createdAt ?? now;
  const convUpdatedAt = conv.updatedAt ?? conv.createdAt ?? now;

  const messageTimestamps = conv.messages.map((msg, i) => {
    if (msg.createdAt != null) return msg.createdAt;
    return convCreatedAt + i;
  });

  return { convCreatedAt, convUpdatedAt, messageTimestamps };
}

// -- Core import logic --

async function importConversations(
  payload: ImportPayload,
): Promise<ImportResult> {
  const db = getDb();
  const memoryConfig = getConfig().memory;

  let imported = 0;
  let skipped = 0;
  let totalMessages = 0;
  const errors: ImportResult["errors"] = [];

  for (let idx = 0; idx < payload.conversations.length; idx++) {
    const conv = payload.conversations[idx];

    try {
      // Dedup via sourceKey
      if (conv.sourceKey) {
        const existing = getConversationByKey(conv.sourceKey);
        if (existing) {
          skipped++;
          continue;
        }
      }

      const { convCreatedAt, convUpdatedAt, messageTimestamps } =
        resolveTimestamps(conv);

      // Create conversation
      const conversation = createConversation(conv.title);

      // Insert messages with skipIndexing (timestamps will be overridden)
      for (const msg of conv.messages) {
        const contentStr =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);

        await addMessage(conversation.id, msg.role, contentStr, undefined, {
          skipIndexing: true,
        });
      }

      // Override conversation timestamps to match originals
      db.update(conversationsTable)
        .set({
          createdAt: convCreatedAt,
          updatedAt: convUpdatedAt,
          lastMessageAt: messageTimestamps[messageTimestamps.length - 1],
        })
        .where(eq(conversationsTable.id, conversation.id))
        .run();

      // Override message timestamps to match originals
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

      // Index messages with original timestamps (non-fatal on failure)
      for (let i = 0; i < dbMessages.length && i < conv.messages.length; i++) {
        const msg = conv.messages[i];
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
          importLog.warn(
            "Failed to index imported message %s in conversation %s: %s",
            dbMessages[i].id,
            conversation.id,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Register sourceKey for dedup
      if (conv.sourceKey) {
        setConversationKey(conv.sourceKey, conversation.id);
      }

      imported++;
      totalMessages += conv.messages.length;
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

// -- CLI registration --

export function registerConversationsImportCommand(
  conversations: Command,
): void {
  conversations
    .command("import")
    .description("Import conversations from a standard JSON format")
    .option("--file <path>", "Read JSON from file instead of stdin")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Imports conversations into the assistant from a standard JSON format.
Reads from stdin by default, or from a file with --file.

The input JSON must have the shape:
  { "conversations": [{ "title": "...", "messages": [...] }] }

Each conversation may include:
  sourceKey         External key for dedup (e.g. "chatgpt:abc123")
  createdAt         Unix epoch milliseconds for the conversation
  updatedAt         Unix epoch milliseconds for the conversation
  messages[].role   "user" or "assistant"
  messages[].content  String or array of {type, text} content blocks
  messages[].createdAt  Unix epoch milliseconds for the message

Messages are indexed for memory search after import. Re-importing with
the same sourceKey will skip already-imported conversations.

Examples:
  $ bun run scripts/parse-export.ts --file export.zip | assistant conversations import --json
  $ assistant conversations import --file import.json --json
  $ cat data.json | assistant conversations import`,
    )
    .action(async (opts: { file?: string; json?: boolean }) => {
      let raw: string;
      try {
        if (opts.file) {
          if (!existsSync(opts.file)) {
            throw new Error(`File not found: ${opts.file}`);
          }
          raw = readFileSync(opts.file, "utf-8");
        } else {
          if (process.stdin.isTTY) {
            throw new Error(
              "No input provided. Pipe JSON into stdin or use --file <path>.",
            );
          }
          raw = readFileSync("/dev/stdin", "utf-8");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      let payload: ImportPayload;
      try {
        const parsed = JSON.parse(raw);
        payload = validatePayload(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      if (payload.conversations.length === 0) {
        const result = { ok: true, imported: 0, skipped: 0, messages: 0 };
        if (opts.json) {
          log.info(JSON.stringify(result));
        } else {
          log.info("No conversations to import.");
        }
        return;
      }

      getDb();
      const result = await importConversations(payload);

      if (opts.json) {
        log.info(JSON.stringify(result));
      } else {
        const lines = [
          `Imported ${result.imported} conversation(s) with ${result.messages} message(s).`,
        ];
        if (result.skipped > 0) {
          lines.push(
            `Skipped ${result.skipped} already-imported conversation(s).`,
          );
        }
        if (result.errors.length > 0) {
          lines.push(`Failed: ${result.errors.length} conversation(s).`);
        }
        log.info(lines.join("\n"));
      }
    });
}
