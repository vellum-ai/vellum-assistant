import { existsSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../../../../config/loader.js";
import {
  addMessage,
  createConversation,
} from "../../../../memory/conversation-crud.js";
import { getDb } from "../../../../memory/db.js";
import { indexMessageNow } from "../../../../memory/indexer.js";
import {
  conversationKeys,
  conversations,
  messages as messagesTable,
} from "../../../../memory/schema.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getLogger } from "../../../../util/logger.js";

const log = getLogger("chatgpt-import");

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

interface ImportedMessage {
  role: string;
  content: Array<{ type: string; text: string }>;
  createdAt: number;
}

interface ImportedConversation {
  sourceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ImportedMessage[];
}

// -- Tool entry point --

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const filePath = input.file_path as string;

  if (!filePath) {
    return { content: "Error: file_path is required", isError: true };
  }

  if (!filePath.endsWith(".zip")) {
    return {
      content:
        "Error: Only ZIP files are accepted. Please provide the ChatGPT export ZIP file.",
      isError: true,
    };
  }

  if (!existsSync(filePath)) {
    return { content: `Error: File not found: ${filePath}`, isError: true };
  }

  let imported: ImportedConversation[];
  try {
    imported = parseChatGPTExport(filePath);
  } catch (err) {
    return {
      content: `Error parsing export file: ${
        err instanceof Error ? err.message : String(err)
      }`,
      isError: true,
    };
  }

  if (imported.length === 0) {
    return {
      content: "No conversations found in the export file.",
      isError: false,
    };
  }

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

    // Skip indexing during insert so we can backfill original timestamps first
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
    db.update(conversations)
      .set({ createdAt: conv.createdAt, updatedAt: conv.updatedAt })
      .where(eq(conversations.id, conversation.id))
      .run();

    // Update message timestamps to match ChatGPT originals
    const dbMessages = db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversation.id))
      .orderBy(messagesTable.createdAt)
      .all();

    const memoryConfig = getConfig().memory;
    for (let i = 0; i < dbMessages.length && i < conv.messages.length; i++) {
      const originalTimestamp = conv.messages[i].createdAt;
      db.update(messagesTable)
        .set({ createdAt: originalTimestamp })
        .where(eq(messagesTable.id, dbMessages[i].id))
        .run();

      // Index with the original ChatGPT timestamp so memory segments
      // reflect actual message age, not import time
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
        // Indexing failure is non-fatal — the message is already persisted,
        // and failing here would abort the loop before conversationKeys is
        // written, causing duplicate imports on retry.
        log.warn(
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

  const lines = [
    `Imported ${importedCount} conversation(s) with ${messageCount} message(s).`,
  ];
  if (skippedCount > 0) {
    lines.push(`Skipped ${skippedCount} already-imported conversation(s).`);
  }
  return { content: lines.join("\n"), isError: false };
}

// -- Parser --

function parseChatGPTExport(zipPath: string): ImportedConversation[] {
  const jsonContent = extractConversationsJsonFromZip(zipPath);

  const raw = JSON.parse(jsonContent);
  if (!Array.isArray(raw)) {
    throw new Error("Expected conversations.json to contain a JSON array");
  }

  const results: ImportedConversation[] = [];
  for (const conv of raw as ChatGPTConversation[]) {
    const imported = parseConversation(conv);
    if (imported) {
      results.push(imported);
    }
  }
  return results;
}

function parseConversation(
  conv: ChatGPTConversation,
): ImportedConversation | null {
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

  const messages: ImportedMessage[] = [];
  for (const id of nodeIds) {
    const node = mapping[id];
    if (!node?.message) continue;

    const { author, content, create_time } = node.message;
    const role = author?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractText(content);
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

function extractText(content: ChatGPTContent): string {
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
      return extractLocalFile(buffer, localHeaderOffset, cdCompressedSize);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error("conversations.json not found in ZIP file");
}

function extractLocalFile(
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
