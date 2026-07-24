import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { optimizeImageForTransport } from "../../agent/image-optimize.js";
import { parseImageDimensions } from "../../context/image-dimensions.js";
import { getConversationsDir } from "../../util/platform.js";
import { classifyKind } from "../attachments-store.js";
import {
  getConversationAttachmentsDirPath,
  isFilesystemSafeConversationId,
} from "../conversation-directories.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const BATCH_SIZE = 10;
const ATTACHMENT_ID_PREFIX = "historical-inline-media-";
const LINK_ID_PREFIX = "historical-inline-media-link-";

export interface HistoricalInlineMediaMigrationOptions {
  resolveAttachmentsDir?: (
    conversationId: string,
    conversationCreatedAt: number,
  ) => string;
  writeFile?: (path: string, data: Buffer) => void;
  readLinkedAttachmentBytes?: (attachmentId: string) => Buffer | null;
  yieldToEventLoop?: () => Promise<void>;
}

interface MessageRow {
  rowid: number;
  id: string;
  content: string;
  createdAt: number;
  conversationId: string;
  conversationCreatedAt: number;
}

interface AttachmentRow {
  id: string;
  dataBase64: string;
  filePath: string | null;
  mimeType: string;
}

interface LinkedAttachmentRow {
  id: string;
  mimeType: string;
  linkId: string;
  position: number;
}

interface AttachmentMatch {
  kind: "exact" | "optimized";
  storedSizeBytes: number;
}

interface ByteSignature {
  digest: string;
  sizeBytes: number;
}

interface SelectedAttachment {
  row: LinkedAttachmentRow;
  match: AttachmentMatch;
}

interface PendingAttachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  filePath: string;
  createdAt: number;
}

interface PendingLink {
  id: string;
  attachmentId: string;
  position: number;
  createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeBase64(data: string): Buffer | null {
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return null;
  }
  const unpadded = data.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    return null;
  }
  const paddingLength = data.length - unpadded.length;
  const canonicalPaddingLength = (4 - (unpadded.length % 4)) % 4;
  if (paddingLength !== 0 && paddingLength !== canonicalPaddingLength) {
    return null;
  }
  const decoded = Buffer.from(unpadded, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    return null;
  }
  return decoded;
}

function readableAttachmentBytes(row: AttachmentRow): Buffer | null {
  if (row.filePath) {
    try {
      return readFileSync(row.filePath);
    } catch {
      return null;
    }
  }
  return decodeBase64(row.dataBase64);
}

function byteSignature(bytes: Buffer): ByteSignature {
  return { digest: sha256(bytes), sizeBytes: bytes.length };
}

function signaturesMatch(left: ByteSignature, right: ByteSignature): boolean {
  return left.sizeBytes === right.sizeBytes && left.digest === right.digest;
}

function hasInlineMediaToMaterialize(block: unknown): boolean {
  if (!isRecord(block)) {
    return false;
  }
  if (block.type === "image" || block.type === "file") {
    return (
      isRecord(block.source) &&
      block.source.type === "base64" &&
      typeof block.source.media_type === "string" &&
      typeof block.source.data === "string"
    );
  }
  return (
    (block.type === "tool_result" || block.type === "web_search_tool_result") &&
    Array.isArray(block.contentBlocks) &&
    block.contentBlocks.some(hasInlineMediaToMaterialize)
  );
}

function matchAttachmentToBlock(
  row: LinkedAttachmentRow,
  readAttachmentBytes: (attachmentId: string) => Buffer | null,
  blockType: "image" | "file",
  mediaType: string,
  inlineSignature: ByteSignature,
  attachmentSignatureCache: Map<string, ByteSignature | null>,
  optimizedSignatureCache: Map<string, ByteSignature | null>,
): AttachmentMatch | null {
  let storedBytes: Buffer | null = null;
  let storedSignature = attachmentSignatureCache.get(row.id);
  if (storedSignature === undefined) {
    storedBytes = readAttachmentBytes(row.id);
    storedSignature = storedBytes ? byteSignature(storedBytes) : null;
    attachmentSignatureCache.set(row.id, storedSignature);
  }
  if (!storedSignature) {
    return null;
  }
  if (signaturesMatch(storedSignature, inlineSignature)) {
    return { kind: "exact", storedSizeBytes: storedSignature.sizeBytes };
  }
  if (blockType !== "image") {
    return null;
  }
  const cacheKey = `${row.id}\0${mediaType}`;
  if (!optimizedSignatureCache.has(cacheKey)) {
    storedBytes ??= readAttachmentBytes(row.id);
    if (!storedBytes) {
      optimizedSignatureCache.set(cacheKey, null);
      return null;
    }
    const optimized = optimizeImageForTransport(
      storedBytes.toString("base64"),
      row.mimeType,
    );
    const optimizedBytes =
      optimized.mediaType === mediaType ? decodeBase64(optimized.data) : null;
    optimizedSignatureCache.set(
      cacheKey,
      optimizedBytes ? byteSignature(optimizedBytes) : null,
    );
  }
  const optimizedSignature = optimizedSignatureCache.get(cacheKey);
  return optimizedSignature &&
    signaturesMatch(optimizedSignature, inlineSignature)
    ? { kind: "optimized", storedSizeBytes: storedSignature.sizeBytes }
    : null;
}

function ensureDeterministicFile(
  filePath: string,
  bytes: Buffer,
  writeFile: (path: string, data: Buffer) => void,
): void {
  let existing: Buffer;
  try {
    existing = readFileSync(filePath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
    writeFile(filePath, bytes);
    return;
  }
  if (!existing.equals(bytes)) {
    throw new Error(
      `Historical inline media path contains different bytes: ${filePath}`,
    );
  }
}

function defaultWriteFile(path: string, data: Buffer): void {
  writeFileSync(path, data, { flag: "wx" });
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function defaultResolveAttachmentsDir(
  conversationId: string,
  conversationCreatedAt: number,
): string {
  const conversationsDir = resolve(getConversationsDir());
  const attachmentsDir = resolve(
    getConversationAttachmentsDirPath(conversationId, conversationCreatedAt),
  );
  if (!attachmentsDir.startsWith(`${conversationsDir}${sep}`)) {
    throw new Error(
      `Historical inline media conversation ID escapes the conversations directory: ${conversationId}`,
    );
  }
  return attachmentsDir;
}

/**
 * Materialize base64 media from finalized inline message content into stable
 * attachment references. Each message's attachment rows, links, and content
 * rewrite commit together; deterministic files are written and verified first
 * so an interrupted run can safely reuse them.
 */
export async function migrateMaterializeHistoricalInlineMessageMedia(
  database: DrizzleDb,
  options: HistoricalInlineMediaMigrationOptions = {},
): Promise<void> {
  const raw = getSqliteFrom(database);
  const resolveAttachmentsDir =
    options.resolveAttachmentsDir ?? defaultResolveAttachmentsDir;
  const writeFile = options.writeFile ?? defaultWriteFile;
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const readLinkedAttachmentBytes =
    options.readLinkedAttachmentBytes ??
    ((attachmentId: string): Buffer | null => {
      const attachment = raw
        .query(
          `SELECT
             id,
             data_base64 AS dataBase64,
             file_path AS filePath,
             mime_type AS mimeType
           FROM attachments WHERE id = ?`,
        )
        .get(attachmentId) as AttachmentRow | null;
      return attachment ? readableAttachmentBytes(attachment) : null;
    });

  let lastRowid = 0;
  for (;;) {
    const rows = raw
      .query(
        `SELECT
           m.rowid AS rowid,
           m.id,
           m.content,
           m.created_at AS createdAt,
           m.conversation_id AS conversationId,
           c.created_at AS conversationCreatedAt
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.finalized = 1 AND m.rowid > ?
         ORDER BY m.rowid
         LIMIT ?`,
      )
      .all(lastRowid, BATCH_SIZE) as MessageRow[];
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      lastRowid = row.rowid;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.content);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) {
        continue;
      }
      if (!parsed.some(hasInlineMediaToMaterialize)) {
        continue;
      }

      const linkedRows = raw
        .query(
          `SELECT
             ma.id AS linkId,
             ma.position,
             a.id,
             a.mime_type AS mimeType
           FROM message_attachments ma
           JOIN attachments a ON a.id = ma.attachment_id
           WHERE ma.message_id = ?
           ORDER BY ma.position, ma.rowid`,
        )
        .all(row.id) as LinkedAttachmentRow[];
      const linkedById = new Map(linkedRows.map((item) => [item.id, item]));
      const attachmentSignatureCache = new Map<string, ByteSignature | null>();
      const optimizedSignatureCache = new Map<string, ByteSignature | null>();
      const consumedLinkIds = new Set<string>();
      const pendingAttachments: PendingAttachment[] = [];
      const pendingLinks: PendingLink[] = [];
      let attachmentsDir: string | null = null;
      let nextPosition =
        linkedRows.reduce((max, item) => Math.max(max, item.position), -1) + 1;
      let changed = false;

      const getAttachmentsDir = (): string => {
        if (attachmentsDir) {
          return attachmentsDir;
        }
        if (!isFilesystemSafeConversationId(row.conversationId)) {
          throw new Error(
            `Historical inline media has an unsafe conversation ID: ${row.conversationId}`,
          );
        }
        attachmentsDir = resolveAttachmentsDir(
          row.conversationId,
          row.conversationCreatedAt,
        );
        mkdirSync(attachmentsDir, { recursive: true });
        return attachmentsDir;
      };

      const convert = (
        block: unknown,
        path: readonly (string | number)[],
      ): unknown => {
        if (!isRecord(block)) {
          return block;
        }
        if (
          (block.type === "tool_result" ||
            block.type === "web_search_tool_result") &&
          Array.isArray(block.contentBlocks)
        ) {
          const contentBlocks = block.contentBlocks;
          const nextContentBlocks = contentBlocks.map((child, index) =>
            convert(child, [...path, "contentBlocks", index]),
          );
          if (
            nextContentBlocks.some(
              (child, index) => child !== contentBlocks[index],
            )
          ) {
            return { ...block, contentBlocks: nextContentBlocks };
          }
          return block;
        }
        if (block.type !== "image" && block.type !== "file") {
          return block;
        }
        if (!isRecord(block.source) || block.source.type !== "base64") {
          return block;
        }
        const mediaType = block.source.media_type;
        const data = block.source.data;
        if (typeof mediaType !== "string" || typeof data !== "string") {
          return block;
        }
        const inlineBytes = decodeBase64(data);
        if (!inlineBytes) {
          return block;
        }
        const inlineSignature = byteSignature(inlineBytes);

        let selected: SelectedAttachment | undefined;
        if (typeof block._attachmentId === "string") {
          const linked = linkedById.get(block._attachmentId);
          if (linked) {
            const match = matchAttachmentToBlock(
              linked,
              readLinkedAttachmentBytes,
              block.type as "image" | "file",
              mediaType,
              inlineSignature,
              attachmentSignatureCache,
              optimizedSignatureCache,
            );
            if (match) {
              selected = { row: linked, match };
            }
          }
        } else {
          for (const linked of linkedRows) {
            if (consumedLinkIds.has(linked.linkId)) {
              continue;
            }
            const match = matchAttachmentToBlock(
              linked,
              readLinkedAttachmentBytes,
              block.type as "image" | "file",
              mediaType,
              inlineSignature,
              attachmentSignatureCache,
              optimizedSignatureCache,
            );
            if (match) {
              selected = { row: linked, match };
              break;
            }
          }
        }

        const jsonPath = path.join("/");
        const contentHash = inlineSignature.digest;
        let attachmentId: string;
        if (selected) {
          attachmentId = selected.row.id;
          consumedLinkIds.add(selected.row.linkId);
        } else {
          attachmentId = `${ATTACHMENT_ID_PREFIX}${sha256(
            `${row.id}\0${jsonPath}\0${contentHash}`,
          )}`;
          const filePath = join(getAttachmentsDir(), attachmentId);
          ensureDeterministicFile(filePath, inlineBytes, writeFile);
          const recovered = raw
            .query(
              `SELECT
                 id,
                 data_base64 AS dataBase64,
                 file_path AS filePath,
                 mime_type AS mimeType
               FROM attachments WHERE id = ?`,
            )
            .get(attachmentId) as AttachmentRow | null;
          if (recovered) {
            const recoveredBytes = readableAttachmentBytes(recovered);
            if (
              recovered.filePath !== filePath ||
              !recoveredBytes?.equals(inlineBytes)
            ) {
              throw new Error(
                `Historical inline media attachment conflicts with deterministic identity: ${attachmentId}`,
              );
            }
          } else {
            pendingAttachments.push({
              id: attachmentId,
              originalFilename:
                typeof block.source.filename === "string"
                  ? block.source.filename
                  : block.type === "image"
                    ? "image"
                    : "attachment",
              mimeType: mediaType,
              sizeBytes: inlineBytes.length,
              kind: classifyKind(mediaType),
              filePath,
              createdAt: row.createdAt,
            });
          }
          pendingLinks.push({
            id: `${LINK_ID_PREFIX}${sha256(
              `${row.id}\0${jsonPath}\0${attachmentId}`,
            )}`,
            attachmentId,
            position: nextPosition++,
            createdAt: row.createdAt,
          });
        }

        const { data: _data, ...sourceMetadata } = block.source;
        const referenceMediaType =
          selected?.match.kind === "optimized"
            ? selected.row.mimeType
            : mediaType;
        const referenceSizeBytes =
          selected?.match.kind === "optimized"
            ? selected.match.storedSizeBytes
            : inlineBytes.length;
        const nextSource: Record<string, unknown> = {
          ...sourceMetadata,
          type: "workspace_ref",
          media_type: referenceMediaType,
          attachmentId,
          sizeBytes: referenceSizeBytes,
        };
        if (block.type === "image") {
          const optimized = optimizeImageForTransport(data, mediaType);
          const dimensions = parseImageDimensions(
            optimized.data,
            optimized.mediaType,
          );
          if (dimensions) {
            nextSource.width = dimensions.width;
            nextSource.height = dimensions.height;
          }
        }
        const { _attachmentId: _legacyAttachmentId, ...blockMetadata } = block;
        changed = true;
        return { ...blockMetadata, source: nextSource };
      };

      const rewritten = parsed.map((block, index) => convert(block, [index]));
      if (!changed) {
        continue;
      }
      const rewrittenContent = JSON.stringify(rewritten);

      const applyMessage = raw.transaction(() => {
        for (const attachment of pendingAttachments) {
          raw
            .query(
              `INSERT INTO attachments (
                 id, original_filename, mime_type, size_bytes, kind,
                 data_base64, content_hash, thumbnail_base64, file_path, created_at
               ) VALUES (?, ?, ?, ?, ?, '', NULL, NULL, ?, ?)`,
            )
            .run(
              attachment.id,
              attachment.originalFilename,
              attachment.mimeType,
              attachment.sizeBytes,
              attachment.kind,
              attachment.filePath,
              attachment.createdAt,
            );
        }
        for (const link of pendingLinks) {
          raw
            .query(
              `INSERT INTO message_attachments (
                 id, message_id, attachment_id, position, created_at
               )
               SELECT ?, ?, ?, ?, ?
               WHERE NOT EXISTS (
                 SELECT 1 FROM message_attachments
                 WHERE message_id = ? AND attachment_id = ?
               )`,
            )
            .run(
              link.id,
              row.id,
              link.attachmentId,
              link.position,
              link.createdAt,
              row.id,
              link.attachmentId,
            );
        }
        const result = raw
          .query(
            `UPDATE messages SET content = ?
             WHERE id = ? AND content = ? AND finalized = 1`,
          )
          .run(rewrittenContent, row.id, row.content);
        if (result.changes !== 1) {
          throw new Error(
            `Historical inline media message changed during migration: ${row.id}`,
          );
        }
      });
      applyMessage();
    }

    await yieldToEventLoop();
  }
}

export function migrateMaterializeHistoricalInlineMessageMediaDown(
  _database: DrizzleDb,
): void {
  // Materialized files and references remain valid across rollback.
}
