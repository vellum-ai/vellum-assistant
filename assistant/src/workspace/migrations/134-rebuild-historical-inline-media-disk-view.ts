import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");
const DB_STEP_KEY = "step:migrateMaterializeHistoricalInlineMessageMedia";
const HISTORICAL_ATTACHMENT_ID_PREFIX = "historical-inline-media-";
const HISTORICAL_ATTACHMENT_GLOB = `${HISTORICAL_ATTACHMENT_ID_PREFIX}*`;

interface ConversationRow {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  conversationType: string;
  originChannel: string | null;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}

interface AttachmentRow {
  id: string;
  messageId: string;
  originalFilename: string;
  dataBase64: string;
  filePath: string | null;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  contentBlocks?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeConversationId(id: string): boolean {
  return (
    id.length > 0 &&
    id !== "." &&
    id !== ".." &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0")
  );
}

function conversationTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString().replace(/:/g, "-");
}

function conversationDir(
  workspaceDir: string,
  id: string,
  createdAt: number,
): string {
  if (!isSafeConversationId(id)) {
    throw new Error(`Unsafe conversation ID in disk-view rebuild: ${id}`);
  }
  const conversationsDir = join(workspaceDir, "conversations");
  const timestamp = conversationTimestamp(createdAt);
  const canonical = join(conversationsDir, `${timestamp}_${id}`);
  if (existsSync(canonical)) {
    return canonical;
  }
  const legacy = join(conversationsDir, `${id}_${timestamp}`);
  return existsSync(legacy) ? legacy : canonical;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function coerceLegacyBlock(block: unknown): ContentBlock {
  if (isRecord(block)) {
    if (block.type === "text") {
      if (typeof block.text === "string") {
        return block as unknown as ContentBlock;
      }
      return { type: "text", text: safeJson(block.text) };
    }
    if (
      block.type === "tool_result" ||
      block.type === "web_search_tool_result"
    ) {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (block.type === "web_search_tool_result") {
        if (typeof block.tool_use_id === "string") {
          return block as unknown as ContentBlock;
        }
        return {
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: block.content,
        };
      }
      if (
        typeof block.tool_use_id === "string" &&
        typeof block.content === "string" &&
        (block.is_error === undefined || typeof block.is_error === "boolean") &&
        (block.contentBlocks === undefined ||
          Array.isArray(block.contentBlocks))
      ) {
        return block as unknown as ContentBlock;
      }
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content:
          typeof block.content === "string"
            ? block.content
            : safeJson(block.content),
        ...(typeof block.is_error === "boolean"
          ? { is_error: block.is_error }
          : {}),
      };
    }
    if (typeof block.type === "string") {
      return block as unknown as ContentBlock;
    }
  }
  return { type: "text", text: safeJson(block) };
}

function foldContentFile(workspaceDir: string, ref: string): unknown[] {
  if (!/^conversations\/.+\.jsonl$/.test(ref)) {
    return [];
  }
  const root = resolve(workspaceDir);
  const path = resolve(root, ref);
  if (path !== root && !path.startsWith(root + sep)) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const byIndex = new Map<number, { seq: number; block: unknown }>();
  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        !isRecord(parsed) ||
        !Number.isInteger(parsed.i) ||
        typeof parsed.seq !== "number" ||
        !("block" in parsed)
      ) {
        continue;
      }
      const index = parsed.i as number;
      const existing = byIndex.get(index);
      if (!existing || parsed.seq > existing.seq) {
        byIndex.set(index, {
          seq: parsed.seq,
          block: parsed.block,
        });
      }
    } catch {
      // A crash-truncated or legacy malformed delta line is ignored.
    }
  }
  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => entry.block);
}

function resolveContentBlocks(
  workspaceDir: string,
  rawContent: string,
): ContentBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return [{ type: "text", text: rawContent }];
  }
  if (Array.isArray(parsed)) {
    return parsed.map(coerceLegacyBlock);
  }
  if (isRecord(parsed) && typeof parsed.ref === "string") {
    return foldContentFile(workspaceDir, parsed.ref).map(coerceLegacyBlock);
  }
  if (typeof parsed === "string") {
    return [{ type: "text", text: parsed }];
  }
  return [{ type: "text", text: rawContent }];
}

function flattenContent(blocks: ContentBlock[]): {
  content: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  toolResults: Array<{ content: unknown }>;
} {
  const text: string[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const toolResults: Array<{ content: unknown }> = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({ name: block.name, input: block.input });
    } else if (
      block.type === "tool_result" ||
      block.type === "web_search_tool_result"
    ) {
      toolResults.push({ content: block.content });
    }
  }
  return { content: text.join("\n"), toolCalls, toolResults };
}

function attachmentBytes(row: AttachmentRow): Buffer | null {
  if (row.filePath) {
    try {
      return readFileSync(row.filePath);
    } catch {
      return null;
    }
  }
  return row.dataBase64 ? Buffer.from(row.dataBase64, "base64") : null;
}

function projectedAttachmentFilename(
  attachmentsDir: string,
  row: AttachmentRow,
): string | null {
  if (
    row.filePath &&
    existsSync(row.filePath) &&
    dirname(row.filePath) === attachmentsDir &&
    statSync(row.filePath).isFile()
  ) {
    return basename(row.filePath);
  }
  const bytes = attachmentBytes(row);
  if (!bytes) {
    if (row.id.startsWith(HISTORICAL_ATTACHMENT_ID_PREFIX)) {
      throw new Error(`Historical attachment bytes are missing: ${row.id}`);
    }
    return null;
  }
  const basenameCandidate = basename(row.originalFilename);
  const safeName =
    basenameCandidate && basenameCandidate !== "." && basenameCandidate !== ".."
      ? basenameCandidate
      : "attachment";
  const extension = extname(safeName);
  const stem = basename(safeName, extension);
  let suffix = 1;
  for (;;) {
    const filename = suffix === 1 ? safeName : `${stem}-${suffix}${extension}`;
    const path = join(attachmentsDir, filename);
    try {
      if (readFileSync(path).equals(bytes)) {
        return filename;
      }
      suffix++;
    } catch (err) {
      if (!isRecord(err) || err.code !== "ENOENT") {
        throw err;
      }
      writeFileSync(path, bytes, { flag: "wx" });
      return filename;
    }
  }
}

function attachmentRowsByMessage(
  db: Database,
  conversationId: string,
): Map<string, AttachmentRow[]> {
  const rows = db
    .query(
      `SELECT
         a.id,
         ma.message_id AS messageId,
         a.original_filename AS originalFilename,
         a.data_base64 AS dataBase64,
         a.file_path AS filePath
       FROM message_attachments ma
       JOIN attachments a ON a.id = ma.attachment_id
       JOIN messages m ON m.id = ma.message_id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at, m.rowid, ma.position, ma.rowid`,
    )
    .all(conversationId) as AttachmentRow[];
  const byMessage = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const messageRows = byMessage.get(row.messageId) ?? [];
    messageRows.push(row);
    byMessage.set(row.messageId, messageRows);
  }
  return byMessage;
}

function rebuildConversation(
  db: Database,
  workspaceDir: string,
  conversation: ConversationRow,
): void {
  const dir = conversationDir(
    workspaceDir,
    conversation.id,
    conversation.createdAt,
  );
  const attachmentsDir = join(dir, "attachments");
  const messagesPath = join(dir, "messages.jsonl");
  const messagesTempPath = `${messagesPath}.migration-134.tmp`;
  mkdirSync(attachmentsDir, { recursive: true });
  writeFileSync(messagesTempPath, "");

  try {
    const attachmentsByMessage = attachmentRowsByMessage(db, conversation.id);
    const messages = db
      .query(
        `SELECT
           id, role, content, created_at AS createdAt, metadata
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(conversation.id) as MessageRow[];
    for (const message of messages) {
      const { content, toolCalls, toolResults } = flattenContent(
        resolveContentBlocks(workspaceDir, message.content),
      );
      const attachments: string[] = [];
      for (const attachment of attachmentsByMessage.get(message.id) ?? []) {
        const filename = projectedAttachmentFilename(
          attachmentsDir,
          attachment,
        );
        if (filename) {
          attachments.push(filename);
        }
      }
      const record: Record<string, unknown> = {
        role: message.role,
        ts: new Date(message.createdAt).toISOString(),
      };
      if (content) {
        record.content = content;
      }
      if (toolCalls.length > 0) {
        record.toolCalls = toolCalls;
      }
      if (toolResults.length > 0) {
        record.toolResults = toolResults;
      }
      if (attachments.length > 0) {
        record.attachments = attachments;
      }
      if (message.metadata) {
        try {
          record.metadata = JSON.parse(message.metadata);
        } catch {
          // Invalid historical metadata is omitted from the derived view.
        }
      }
      appendFileSync(messagesTempPath, `${JSON.stringify(record)}\n`);
    }
    renameSync(messagesTempPath, messagesPath);

    const meta = {
      id: conversation.id,
      title: conversation.title,
      type: conversation.conversationType,
      channel: conversation.originChannel,
      createdAt: new Date(conversation.createdAt).toISOString(),
      updatedAt: new Date(conversation.updatedAt).toISOString(),
    };
    const metaPath = join(dir, "meta.json");
    const metaTempPath = `${metaPath}.migration-134.tmp`;
    writeFileSync(metaTempPath, `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(metaTempPath, metaPath);
  } catch (err) {
    rmSync(messagesTempPath, { force: true });
    throw err;
  }
}

export const rebuildHistoricalInlineMediaDiskViewMigration: WorkspaceMigration =
  {
    id: "134-rebuild-historical-inline-media-disk-view",
    description:
      "Rebuild disk views for conversations with materialized historical inline media",
    retryFailedCheckpoint: true,

    run(workspaceDir: string): void {
      const dbPath = join(workspaceDir, "data", "db", "assistant.db");
      if (!existsSync(dbPath)) {
        throw new Error("Assistant database is unavailable for migration 134");
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        // Workspace migrations still run during degraded startup after a DB
        // step fails. Keep this checkpoint retryable until its source rows and
        // deterministic attachment links are known to be complete.
        const checkpoint = db
          .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
          .get(DB_STEP_KEY) as { value: string } | null;
        if (checkpoint?.value !== "1") {
          throw new Error(
            "Historical inline media DB migration has not completed",
          );
        }
        const conversations = db
          .query(
            `SELECT DISTINCT
               c.id,
               c.title,
               c.created_at AS createdAt,
               c.updated_at AS updatedAt,
               c.conversation_type AS conversationType,
               c.origin_channel AS originChannel
             FROM conversations c
             JOIN messages m ON m.conversation_id = c.id
             JOIN message_attachments ma ON ma.message_id = m.id
             JOIN attachments a ON a.id = ma.attachment_id
             WHERE a.id GLOB ?
             ORDER BY c.created_at, c.id`,
          )
          .all(HISTORICAL_ATTACHMENT_GLOB) as ConversationRow[];
        for (const conversation of conversations) {
          rebuildConversation(db, workspaceDir, conversation);
        }
        if (conversations.length > 0) {
          log.info(
            { conversations: conversations.length },
            "Rebuilt historical inline-media conversation disk views",
          );
        }
      } finally {
        db.close();
      }
    },

    down(_workspaceDir: string): void {
      // Derived disk-view files remain valid after rollback.
    },
  };
