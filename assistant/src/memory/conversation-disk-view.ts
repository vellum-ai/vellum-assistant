/**
 * Write-through disk view for conversations.
 *
 * Projects conversation metadata, messages, and attachments to a browsable
 * filesystem layout under ~/.vellum/workspace/conversations/. This enables
 * the assistant to search/read/manipulate conversation data using standard
 * file tools.
 *
 * All disk writes are best-effort — failures are logged but never thrown,
 * so the disk view cannot break DB operations.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getConversationsDir } from "../util/platform.js";
import {
  getAttachmentContent,
  getAttachmentMetadataForMessage,
  getFilePathForAttachment,
} from "./attachments-store.js";
import { getMessageById } from "./conversation-crud.js";

const log = getLogger("conversation-disk-view");

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function getConversationDirTimestamp(createdAtMs: number): string {
  return new Date(createdAtMs).toISOString().replace(/:/g, "-");
}

/**
 * Build a filesystem-safe directory name for a conversation.
 * Format: `{isoDate}_{id}` where colons in the ISO date are replaced with
 * hyphens so the name is valid on all platforms (Windows forbids colons).
 */
export function getConversationDirName(
  id: string,
  createdAtMs: number,
): string {
  return `${getConversationDirTimestamp(createdAtMs)}_${id}`;
}

/**
 * Return the absolute path to a conversation's disk-view directory.
 */
export function getConversationDirPath(
  id: string,
  createdAtMs: number,
): string {
  return join(getConversationsDir(), getConversationDirName(id, createdAtMs));
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create the conversation directory and write the initial meta.json.
 */
export function initConversationDir(conv: {
  id: string;
  title: string | null;
  createdAt: number;
  conversationType: string;
  originChannel: string | null;
}): void {
  try {
    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    mkdirSync(dirPath, { recursive: true });

    const meta = {
      id: conv.id,
      title: conv.title,
      type: conv.conversationType,
      channel: conv.originChannel,
      createdAt: new Date(conv.createdAt).toISOString(),
      updatedAt: new Date(conv.createdAt).toISOString(),
    };

    writeFileSync(
      join(dirPath, "meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
    );
  } catch (err) {
    log.warn(
      { err, conversationId: conv.id },
      "Failed to init conversation dir",
    );
  }
}

/**
 * Rewrite meta.json with updated fields.
 */
export function updateMetaFile(conv: {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  conversationType: string;
  originChannel: string | null;
}): void {
  try {
    const dirPath = getConversationDirPath(conv.id, conv.createdAt);

    const meta = {
      id: conv.id,
      title: conv.title,
      type: conv.conversationType,
      channel: conv.originChannel,
      createdAt: new Date(conv.createdAt).toISOString(),
      updatedAt: new Date(conv.updatedAt).toISOString(),
    };

    writeFileSync(
      join(dirPath, "meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
    );
  } catch (err) {
    log.warn({ err, conversationId: conv.id }, "Failed to update meta file");
  }
}

// ---------------------------------------------------------------------------
// Content flattening
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface FlattenedContent {
  content: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  toolResults: Array<{ content: unknown }>;
}

/**
 * Parse the message `content` JSON string (ContentBlock[]) and extract
 * text, tool_use, and tool_result blocks into flat fields.
 */
export function flattenContentBlocks(rawContent: string): FlattenedContent {
  const result: FlattenedContent = {
    content: "",
    toolCalls: [],
    toolResults: [],
  };

  let blocks: ContentBlock[];
  try {
    const parsed = JSON.parse(rawContent);
    if (!Array.isArray(parsed)) {
      // Plain text content (not block array)
      return { ...result, content: rawContent };
    }
    blocks = parsed;
  } catch {
    // Not valid JSON — treat as plain text
    return { ...result, content: rawContent };
  }

  const textParts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          textParts.push(block.text);
        }
        break;
      case "tool_use":
        if (typeof block.name === "string") {
          result.toolCalls.push({ name: block.name, input: block.input });
        }
        break;
      case "tool_result":
        result.toolResults.push({ content: block.content });
        break;
      // Skip "image" and "file" blocks — represented via attachments
    }
  }

  result.content = textParts.join("\n");
  return result;
}

// ---------------------------------------------------------------------------
// Attachment projection
// ---------------------------------------------------------------------------

/**
 * Resolve a unique filename within a directory, handling collisions by
 * appending a suffix (e.g., `photo-2.png`, `photo-3.png`).
 */
export function resolveUniqueFilename(dir: string, filename: string): string {
  const sanitized = basename(filename);
  if (!existsSync(join(dir, sanitized))) return sanitized;

  const ext = extname(sanitized);
  const base = basename(sanitized, ext);
  let counter = 2;
  let candidate: string;
  do {
    candidate = `${base}-${counter}${ext}`;
    counter++;
  } while (existsSync(join(dir, candidate)));

  return candidate;
}

/**
 * Ensure an attachment is present in the conversation's attachments/
 * subdirectory and return the filename recorded in the disk view.
 */
function writeAttachmentFile(
  conversationDirPath: string,
  attachmentId: string,
  originalFilename: string,
): string | null {
  try {
    const attachDir = join(conversationDirPath, "attachments");
    mkdirSync(attachDir, { recursive: true });

    const existingPath = getFilePathForAttachment(attachmentId);
    if (
      existingPath &&
      existsSync(existingPath) &&
      dirname(existingPath) === attachDir
    ) {
      return basename(existingPath);
    }

    const content = getAttachmentContent(attachmentId);
    if (!content) return null;

    const resolvedName = resolveUniqueFilename(attachDir, originalFilename);
    writeFileSync(join(attachDir, resolvedName), content);
    return resolvedName;
  } catch (err) {
    log.warn(
      { err, attachmentId, originalFilename },
      "Failed to write attachment file to disk",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message sync
// ---------------------------------------------------------------------------

/**
 * Read a message and its attachments from DB, flatten content, and append
 * a JSONL line to `messages.jsonl` in the conversation's disk-view directory.
 * Attachment filenames are recorded from the conversation's attachments/
 * subdirectory, materializing legacy rows there only when needed.
 *
 * Requires `createdAtMs` of the conversation to resolve the directory path.
 */
export function syncMessageToDisk(
  conversationId: string,
  messageId: string,
  createdAtMs: number,
): void {
  try {
    const message = getMessageById(messageId, conversationId);
    if (!message) {
      log.warn(
        { conversationId, messageId },
        "syncMessageToDisk: message not found",
      );
      return;
    }

    const dirPath = getConversationDirPath(conversationId, createdAtMs);
    const { content, toolCalls, toolResults } = flattenContentBlocks(
      message.content,
    );

    // Project attachments to disk
    const attachmentMeta = getAttachmentMetadataForMessage(messageId);
    const attachmentFilenames: string[] = [];
    for (const att of attachmentMeta) {
      const resolved = writeAttachmentFile(
        dirPath,
        att.id,
        att.originalFilename,
      );
      if (resolved) {
        attachmentFilenames.push(resolved);
      }
    }

    // Build JSONL record
    const record: Record<string, unknown> = {
      role: message.role,
      ts: new Date(message.createdAt).toISOString(),
    };

    if (content) record.content = content;
    if (toolCalls.length > 0) record.toolCalls = toolCalls;
    if (toolResults.length > 0) record.toolResults = toolResults;
    if (attachmentFilenames.length > 0)
      record.attachments = attachmentFilenames;

    appendFileSync(
      join(dirPath, "messages.jsonl"),
      JSON.stringify(record) + "\n",
    );
  } catch (err) {
    log.warn(
      { err, conversationId, messageId },
      "Failed to sync message to disk",
    );
  }
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Remove a conversation's disk-view directory entirely.
 */
export function removeConversationDir(id: string, createdAtMs: number): void {
  try {
    const dirPath = getConversationDirPath(id, createdAtMs);
    rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, conversationId: id }, "Failed to remove conversation dir");
  }
}
