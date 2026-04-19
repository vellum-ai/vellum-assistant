import { existsSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import type { Command } from "commander";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  getQdrantUrlEnv,
  getRuntimeHttpHost,
  getRuntimeHttpPort,
} from "../../config/env.js";
import { getConfig } from "../../config/loader.js";
import { shouldAutoStartDaemon } from "../../daemon/connection-policy.js";
import { healthCheckHost, isHttpHealthy } from "../../daemon/daemon-control.js";
import { ensureDaemonRunning } from "../../daemon/lifecycle.js";
import { formatJson, formatMarkdown } from "../../export/formatter.js";
import { cliIpcCall } from "../../ipc/cli-client.js";
import {
  addMessage,
  clearAll as clearAllConversations,
  countConversationsByScheduleJobId,
  createConversation,
  getConversation,
  getMessages,
  wipeConversation,
} from "../../memory/conversation-crud.js";
import { listConversations } from "../../memory/conversation-queries.js";
import { getDb } from "../../memory/db.js";
import {
  selectEmbeddingBackend,
  SPARSE_EMBEDDING_VERSION,
} from "../../memory/embedding-backend.js";
import { indexMessageNow } from "../../memory/indexer.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { initQdrantClient } from "../../memory/qdrant-client.js";
import {
  conversationKeys,
  conversations as conversationsTable,
  messages as messagesTable,
} from "../../memory/schema.js";
import {
  initAuthSigningKey,
  loadOrCreateSigningKey,
  mintDaemonDeliveryToken,
} from "../../runtime/auth/token-service.js";
import { deleteSchedule } from "../../schedule/schedule-store.js";
import { getLogger } from "../../util/logger.js";
import { timeAgo } from "../../util/time.js";
import { initializeDb } from "../db.js";
import { log } from "../logger.js";

const importLog = getLogger("chatgpt-import");

export function registerConversationsCommand(program: Command): void {
  const conversations = program
    .command("conversations")
    .description("Manage conversations");

  conversations.addHelpText(
    "after",
    `
Conversations with the assistant. Each conversation has a unique ID and a
title. The assistant must be running for "new" (it communicates via the HTTP
API), while "list", "export", "import", and "clear" operate on the local SQLite
database directly.

Examples:
  $ assistant conversations list
  $ assistant conversations new "Project planning"
  $ assistant conversations export
  $ assistant conversations import ~/Downloads/chatgpt-export.zip
  $ assistant conversations clear`,
  );

  conversations
    .command("list")
    .description("List all conversations")
    .addHelpText(
      "after",
      `
Shows all conversations with their ID, title, and a relative timestamp (e.g.
"3 hours ago"). Conversations are listed in order of most recently updated.

Operates on the local SQLite database directly — does not require the assistant.

Examples:
  $ assistant conversations list`,
    )
    .action(async () => {
      initializeDb();
      const all = listConversations(Number.MAX_SAFE_INTEGER);
      if (all.length === 0) {
        log.info("No conversations");
      } else {
        for (const s of all) {
          log.info(
            `  ${s.id}  ${s.title ?? "Untitled"}  ${timeAgo(s.updatedAt)}`,
          );
        }
      }
    });

  conversations
    .command("new [title]")
    .description("Create a new conversation")
    .addHelpText(
      "after",
      `
Arguments:
  title   Optional conversation title (string). If omitted, a default title is
          assigned by the assistant.

Creates a new conversation and prints its title and ID.

Examples:
  $ assistant conversations new
  $ assistant conversations new "Project planning"
  $ assistant conversations new "Bug triage 2026-03-05"`,
    )
    .action(async (title?: string) => {
      if (shouldAutoStartDaemon()) await ensureDaemonRunning();
      initializeDb();
      const conversation = createConversation(title);
      log.info(
        `Created conversation: ${conversation.title ?? "New Conversation"} (${conversation.id})`,
      );
    });

  conversations
    .command("export [conversationId]")
    .description("Export a conversation as markdown or JSON")
    .option("-f, --format <format>", "Output format: md or json", "md")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .addHelpText(
      "after",
      `
Arguments:
  conversationId   Optional conversation ID (or unique prefix). Defaults to the
                   most recent conversation. Supports prefix matching — e.g.
                   "abc123" matches the first conversation whose ID starts with
                   "abc123". Run 'assistant conversations list' to find IDs.

Two output formats are available:
  md    Markdown conversation transcript (default). Human-readable rendering
        of messages with role headers.
  json  Structured JSON export with full metadata, message content arrays,
        and timestamps.

Operates on the local SQLite database directly — does not require the assistant.

Examples:
  $ assistant conversations export
  $ assistant conversations export --format json -o conversation.json
  $ assistant conversations export abc123 --format md`,
    )
    .action(
      async (
        conversationId?: string,
        opts?: { format: string; output?: string },
      ) => {
        initializeDb();
        const format = opts?.format ?? "md";
        if (format !== "md" && format !== "json") {
          log.error('Error: format must be "md" or "json"');
          process.exit(1);
        }

        let id = conversationId;
        if (!id) {
          const all = listConversations(1);
          if (all.length === 0) {
            log.error("No conversations found");
            process.exit(1);
          }
          id = all[0].id;
        }

        // Support prefix matching for conversation IDs
        let conversation = getConversation(id);
        if (!conversation) {
          const all = listConversations(Number.MAX_SAFE_INTEGER);
          const match = all.find((c) => c.id.startsWith(id!));
          if (match) {
            conversation = match;
          } else {
            log.error(`Conversation not found: ${id}`);
            process.exit(1);
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
          format === "json"
            ? formatJson(exportData)
            : formatMarkdown(exportData);

        if (opts?.output) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(opts.output, output);
          log.info(`Exported to ${opts.output}`);
        } else {
          process.stdout.write(output);
        }
      },
    );

  conversations
    .command("clear")
    .description(
      "Clear all conversations, messages, and vector data (dev only)",
    )
    .addHelpText(
      "after",
      `
Permanently deletes ALL conversations, messages, and Qdrant vector data.
Prompts for confirmation (y/N) before proceeding. After clearing the local
database, the running assistant (if any) will pick up the changes on the next
request.

Operates on the local SQLite database and Qdrant directly — does not require
the assistant.

Intended for development use. This action cannot be undone.

Examples:
  $ assistant conversations clear`,
    )
    .action(async () => {
      log.info(
        "This will permanently delete all conversations, messages, and vector data.",
      );

      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question("Are you sure? (y/N) ", resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== "y") {
        log.info("Cancelled");
        return;
      }

      initializeDb();
      const result = clearAllConversations();
      log.info(
        `Cleared ${result.conversations} conversations, ${result.messages} messages`,
      );

      const config = getConfig();
      const qdrantUrl = getQdrantUrlEnv() || config.memory.qdrant.url;
      const embeddingSelection = await selectEmbeddingBackend(config);
      const embeddingModel = embeddingSelection.backend
        ? `${embeddingSelection.backend.provider}:${embeddingSelection.backend.model}:sparse-v${SPARSE_EMBEDDING_VERSION}`
        : undefined;
      const qdrant = initQdrantClient({
        url: qdrantUrl,
        collection: config.memory.qdrant.collection,
        vectorSize: config.memory.qdrant.vectorSize,
        onDisk: config.memory.qdrant.onDisk,
        quantization: config.memory.qdrant.quantization,
        embeddingModel,
      });
      const deleted = await qdrant.deleteCollection();
      if (deleted) {
        log.info(
          `Deleted Qdrant collection "${config.memory.qdrant.collection}"`,
        );
      } else {
        log.info("Qdrant collection not found or not reachable (skipped)");
      }

      log.info("Done.");
    });

  conversations
    .command("wipe <conversationId>")
    .description("Wipe a conversation and revert all memory changes it made")
    .option("-y, --yes", "Skip confirmation prompt")
    .addHelpText(
      "after",
      `
Arguments:
  conversationId   Conversation ID (or unique prefix). Supports prefix matching.
                   Run 'assistant conversations list' to find IDs.

Permanently wipes the conversation and reverts all memory changes it caused:
restores superseded memory items, deletes conversation summaries, and cancels
pending memory jobs. This action cannot be undone.

Examples:
  $ assistant conversations wipe abc123
  $ assistant conversations wipe abc123 --yes`,
    )
    .action(async (conversationId: string, opts?: { yes?: boolean }) => {
      initializeDb();

      // Resolve conversation with prefix matching (same pattern as `export`)
      let conversation = getConversation(conversationId);
      if (!conversation) {
        const all = listConversations(Number.MAX_SAFE_INTEGER);
        const match = all.find((c) => c.id.startsWith(conversationId));
        if (match) {
          conversation = match;
        } else {
          log.error(`Conversation not found: ${conversationId}`);
          process.exit(1);
        }
      }

      if (!opts?.yes) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            `Wipe conversation "${conversation!.title ?? "Untitled"}" and revert all memory changes? (y/N) `,
            resolve,
          );
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          log.info("Cancelled");
          return;
        }
      }

      // When the assistant is running, delegate to its HTTP wipe endpoint
      // so it tears down in-memory conversation state before deleting DB
      // rows — preventing FK constraint failures from follow-up writes.
      if (await isHttpHealthy()) {
        const port = getRuntimeHttpPort();
        const host = healthCheckHost(getRuntimeHttpHost());
        initAuthSigningKey(loadOrCreateSigningKey());
        const token = mintDaemonDeliveryToken();
        const res = await fetch(
          `http://${host}:${port}/v1/conversations/${conversation.id}/wipe`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!res.ok) {
          const body = await res.text();
          log.error(`Assistant wipe failed (${res.status}): ${body}`);
          process.exit(1);
        }
        const json = (await res.json()) as {
          unsupersededItems: number;
          deletedSummaries: number;
          cancelledJobs: number;
        };
        log.info(
          `Wiped conversation "${conversation.title ?? "Untitled"}". ` +
            `Restored ${json.unsupersededItems} memory items, ` +
            `deleted ${json.deletedSummaries} summaries, ` +
            `cancelled ${json.cancelledJobs} jobs.`,
        );
        return;
      }

      // Cancel the associated schedule job (if any) before wiping —
      // but only when this is the last conversation referencing it.
      if (
        conversation.scheduleJobId &&
        countConversationsByScheduleJobId(conversation.scheduleJobId) <= 1
      ) {
        deleteSchedule(conversation.scheduleJobId);
      }

      // Daemon not running — safe to wipe directly (no in-memory state).
      const result = wipeConversation(conversation.id);

      // Enqueue Qdrant cleanup
      for (const segId of result.segmentIds) {
        enqueueMemoryJob("delete_qdrant_vectors", {
          targetType: "segment",
          targetId: segId,
        });
      }
      for (const summaryId of result.deletedSummaryIds) {
        enqueueMemoryJob("delete_qdrant_vectors", {
          targetType: "summary",
          targetId: summaryId,
        });
      }

      log.info(
        `Wiped conversation "${conversation.title ?? "Untitled"}". ` +
          `Deleted ${result.deletedSummaryIds.length} summaries, ` +
          `cancelled ${result.cancelledJobCount} jobs.`,
      );
    });

  conversations
    .command("wake <conversationId>")
    .description(
      "Wake the agent on an existing conversation with an internal hint",
    )
    .requiredOption(
      "--hint <text>",
      "Hint message visible to the LLM (not persisted to transcript)",
    )
    .option(
      "--source <label>",
      "Source label for logging (e.g. github-notification)",
      "cli",
    )
    .option("--json", "Output result as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  conversationId   Conversation ID to wake.

Wake the assistant's agent loop on an existing conversation without a user
message. The hint is injected as a non-persisted internal message visible
only to the LLM — it never appears in the transcript or SSE feed. If the
agent produces output (text or tool calls), it is persisted and emitted to
connected clients. Otherwise the wake is a silent no-op.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations wake abc123 --hint "PR #25933 received a review requesting changes"
  $ assistant conversations wake abc123 --hint "CI failed on commit abc" --source github-ci
  $ assistant conversations wake abc123 --hint "New Slack DM from Vargas" --source slack --json`,
    )
    .action(
      async (
        conversationId: string,
        opts: { hint: string; source: string; json?: boolean },
      ) => {
        const result = await cliIpcCall<{
          invoked: boolean;
          producedToolCalls: boolean;
          reason?: "not_found" | "timeout" | "no_resolver";
        }>("wake_conversation", {
          conversationId,
          hint: opts.hint,
          source: opts.source,
        });

        if (!result.ok) {
          if (opts.json) {
            log.info(JSON.stringify({ ok: false, error: result.error }));
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        const wake = result.result!;
        if (opts.json) {
          log.info(JSON.stringify({ ok: true, ...wake }));
          return;
        }
        if (wake.invoked) {
          log.info(
            wake.producedToolCalls
              ? `Wake produced output on conversation ${conversationId}`
              : `Wake invoked on ${conversationId} (no output produced)`,
          );
        } else if (wake.reason === "timeout") {
          // Conversation exists but stayed busy past the wait-until-idle
          // window. This is a transient condition, not an error — the
          // caller can retry later. Exit 0.
          log.info(
            `Conversation ${conversationId} is busy — wake skipped (retry later)`,
          );
        } else {
          log.error(
            `Could not wake conversation ${conversationId} — conversation not found`,
          );
          process.exitCode = 1;
        }
      },
    );

  conversations
    .command("import <filePath>")
    .description(
      "Import conversation history from a ChatGPT export ZIP archive",
    )
    .option("--json", "Output result as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  filePath   Absolute path to the ChatGPT export ZIP file

Imports conversations from a ChatGPT data export. The ZIP file is the archive
that ChatGPT emails after requesting a data export (Settings → Data controls →
Export data). Only conversations.json inside the ZIP is processed.

Conversations are deduplicated — re-importing the same file will skip already-
imported conversations. Only user and assistant messages are imported (system
prompts and tool calls are filtered out). Original timestamps from ChatGPT are
preserved, and imported messages are indexed for memory search.

Operates on the local SQLite database directly — does not require the assistant.

Examples:
  $ assistant conversations import ~/Downloads/chatgpt-export.zip
  $ assistant conversations import /tmp/export.zip --json`,
    )
    .action(async (filePath: string, opts?: { json?: boolean }) => {
      if (!filePath.endsWith(".zip")) {
        const msg =
          "Only ZIP files are accepted. Please provide the ChatGPT export ZIP file.";
        if (opts?.json) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      if (!existsSync(filePath)) {
        const msg = `File not found: ${filePath}`;
        if (opts?.json) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      let imported: ChatGPTImportedConversation[];
      try {
        imported = parseChatGPTExport(filePath);
      } catch (err) {
        const msg = `Error parsing export file: ${err instanceof Error ? err.message : String(err)}`;
        if (opts?.json) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      if (imported.length === 0) {
        const result = {
          ok: true,
          imported: 0,
          skipped: 0,
          messages: 0,
        };
        if (opts?.json) {
          log.info(JSON.stringify(result));
        } else {
          log.info("No conversations found in the export file.");
        }
        return;
      }

      initializeDb();
      const db = getDb();
      let importedCount = 0;
      let skippedCount = 0;
      let messageCount = 0;

      for (const conv of imported) {
        const convKey = `chatgpt:${conv.sourceId}`;

        const existing = db
          .select()
          .from(conversationKeys)
          .where(eq(conversationKeys.conversationKey, convKey))
          .get();

        if (existing) {
          skippedCount++;
          continue;
        }

        const conversation = createConversation(conv.title);

        for (const msg of conv.messages) {
          await addMessage(
            conversation.id,
            msg.role,
            JSON.stringify(msg.content),
            undefined,
            { skipIndexing: true },
          );
        }

        // Override timestamps to match ChatGPT originals
        db.update(conversationsTable)
          .set({ createdAt: conv.createdAt, updatedAt: conv.updatedAt })
          .where(eq(conversationsTable.id, conversation.id))
          .run();

        // Update message timestamps to match ChatGPT originals
        const dbMessages = db
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversation.id))
          .orderBy(messagesTable.createdAt)
          .all();

        const memoryConfig = getConfig().memory;
        for (
          let i = 0;
          i < dbMessages.length && i < conv.messages.length;
          i++
        ) {
          const originalTimestamp = conv.messages[i].createdAt;
          db.update(messagesTable)
            .set({ createdAt: originalTimestamp })
            .where(eq(messagesTable.id, dbMessages[i].id))
            .run();

          try {
            await indexMessageNow(
              {
                messageId: dbMessages[i].id,
                conversationId: conversation.id,
                role: conv.messages[i].role,
                content: JSON.stringify(conv.messages[i].content),
                createdAt: originalTimestamp,
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

        db.insert(conversationKeys)
          .values({
            id: uuid(),
            conversationKey: convKey,
            conversationId: conversation.id,
            createdAt: Date.now(),
          })
          .run();

        importedCount++;
        messageCount += conv.messages.length;
      }

      if (opts?.json) {
        log.info(
          JSON.stringify({
            ok: true,
            imported: importedCount,
            skipped: skippedCount,
            messages: messageCount,
          }),
        );
      } else {
        const lines = [
          `Imported ${importedCount} conversation(s) with ${messageCount} message(s).`,
        ];
        if (skippedCount > 0) {
          lines.push(
            `Skipped ${skippedCount} already-imported conversation(s).`,
          );
        }
        log.info(lines.join("\n"));
      }
    });
}

// -- ChatGPT export format types --

interface ChatGPTContent {
  content_type: string;
  parts?: (string | null | Record<string, unknown>)[];
}

interface ChatGPTNode {
  message: {
    author: { role: string };
    content: ChatGPTContent;
    create_time?: number | null;
  } | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTConversation {
  id?: string;
  title: string;
  create_time: number;
  update_time: number;
  current_node: string;
  mapping: Record<string, ChatGPTNode>;
}

interface ChatGPTImportedMessage {
  role: string;
  content: Array<{ type: string; text: string }>;
  createdAt: number;
}

interface ChatGPTImportedConversation {
  sourceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatGPTImportedMessage[];
}

// -- Parser --

function parseChatGPTExport(zipPath: string): ChatGPTImportedConversation[] {
  const jsonContent = extractConversationsJsonFromZip(zipPath);

  const raw = JSON.parse(jsonContent);
  if (!Array.isArray(raw)) {
    throw new Error("Expected conversations.json to contain a JSON array");
  }

  const results: ChatGPTImportedConversation[] = [];
  for (const conv of raw as ChatGPTConversation[]) {
    const imported = parseChatGPTConversation(conv);
    if (imported) {
      results.push(imported);
    }
  }
  return results;
}

function parseChatGPTConversation(
  conv: ChatGPTConversation,
): ChatGPTImportedConversation | null {
  const { mapping, current_node } = conv;
  if (!mapping || !current_node || !mapping[current_node]) return null;

  // Walk from current_node to root via parent pointers, then reverse for chronological order
  const nodeIds: string[] = [];
  let nodeId: string | null = current_node;
  while (nodeId) {
    nodeIds.push(nodeId);
    nodeId = mapping[nodeId]?.parent ?? null;
  }
  nodeIds.reverse();

  const messages: ChatGPTImportedMessage[] = [];
  for (const id of nodeIds) {
    const node = mapping[id];
    if (!node?.message) continue;

    const { author, content, create_time } = node.message;
    const role = author?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractChatGPTText(content);
    if (!text) continue;

    messages.push({
      role,
      content: [{ type: "text", text }],
      createdAt: create_time
        ? Math.round(create_time * 1000)
        : Math.round(conv.create_time * 1000),
    });
  }

  if (messages.length === 0) return null;

  return {
    sourceId: conv.id ?? `${conv.title}-${conv.create_time}`,
    title: conv.title || "Untitled",
    createdAt: Math.round(conv.create_time * 1000),
    updatedAt: Math.round(conv.update_time * 1000),
    messages,
  };
}

function extractChatGPTText(content: ChatGPTContent): string {
  if (!content?.parts) return "";
  return content.parts
    .filter((p): p is string => typeof p === "string")
    .join("");
}

// -- ZIP extraction --

function extractConversationsJsonFromZip(zipPath: string): string {
  const buffer = readFileSync(zipPath);

  // Find end of central directory record (EOCD signature: 0x06054b50)
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error(
      "Invalid ZIP file: could not find end of central directory",
    );
  }

  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirEntries = buffer.readUInt16LE(eocdOffset + 10);

  // Walk central directory to find conversations.json
  let offset = centralDirOffset;
  for (let i = 0; i < centralDirEntries; i++) {
    if (
      buffer[offset] !== 0x50 ||
      buffer[offset + 1] !== 0x4b ||
      buffer[offset + 2] !== 0x01 ||
      buffer[offset + 3] !== 0x02
    ) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const cdCompressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString("utf-8");

    if (
      fileName === "conversations.json" ||
      fileName.endsWith("/conversations.json")
    ) {
      return extractChatGPTLocalFile(
        buffer,
        localHeaderOffset,
        cdCompressedSize,
      );
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error("conversations.json not found in ZIP file");
}

function extractChatGPTLocalFile(
  buffer: Buffer,
  offset: number,
  cdCompressedSize: number,
): string {
  if (
    buffer[offset] !== 0x50 ||
    buffer[offset + 1] !== 0x4b ||
    buffer[offset + 2] !== 0x03 ||
    buffer[offset + 3] !== 0x04
  ) {
    throw new Error("Invalid ZIP local file header");
  }

  const compressionMethod = buffer.readUInt16LE(offset + 8);
  const localCompressedSize = buffer.readUInt32LE(offset + 18);
  const compressedSize =
    cdCompressedSize > 0 ? cdCompressedSize : localCompressedSize;
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);

  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const fileData = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) {
    return fileData.toString("utf-8");
  } else if (compressionMethod === 8) {
    return inflateRawSync(fileData).toString("utf-8");
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }
}
