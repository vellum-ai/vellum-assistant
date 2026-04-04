import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Rewrite existing user messages so that inline image/file content blocks
 * backed by message_attachments rows are replaced with attachment-backed
 * reference blocks (`image_ref` / `file_ref`).
 *
 * This removes the redundant base64 payload from persisted message JSON,
 * keeping only the attachment ID and metadata. The bytes remain in the
 * attachment store (on-disk file) and are hydrated just-in-time before
 * each provider call.
 *
 * The migration is idempotent: messages that already use ref blocks, or
 * that have mismatched attachment counts, are left unchanged.
 */

interface AttachmentRow {
  attachment_id: string;
  position: number;
  mime_type: string;
  original_filename: string;
  size_bytes: number;
}

function isInlineImageBlock(block: Record<string, unknown>): boolean {
  return (
    block.type === "image" &&
    typeof block.source === "object" &&
    block.source !== null &&
    (block.source as Record<string, unknown>).type === "base64" &&
    typeof (block.source as Record<string, unknown>).data === "string" &&
    ((block.source as Record<string, unknown>).data as string).length > 0
  );
}

function isInlineFileBlock(block: Record<string, unknown>): boolean {
  return (
    block.type === "file" &&
    typeof block.source === "object" &&
    block.source !== null &&
    (block.source as Record<string, unknown>).type === "base64" &&
    typeof (block.source as Record<string, unknown>).data === "string" &&
    ((block.source as Record<string, unknown>).data as string).length > 0
  );
}

export function migrateBackfillUserMessageAttachmentRefs(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_backfill_user_message_attachment_refs_v1",
    () => {
      const raw = getSqliteFrom(database);
      const BATCH_SIZE = 50;
      let totalRewritten = 0;
      let lastRowid = 0;

      for (;;) {
        // Fetch user messages that have message_attachments links, in batches.
        const rows = raw
          .query(
            `SELECT m.rowid, m.id, m.content
             FROM messages m
             WHERE m.role = 'user'
               AND EXISTS (
                 SELECT 1 FROM message_attachments ma WHERE ma.message_id = m.id
               )
               AND m.rowid > ?
             ORDER BY m.rowid
             LIMIT ?`,
          )
          .all(lastRowid, BATCH_SIZE) as Array<{
          rowid: number;
          id: string;
          content: string;
        }>;

        if (rows.length === 0) break;

        for (const row of rows) {
          lastRowid = row.rowid;

          let blocks: unknown[];
          try {
            const parsed = JSON.parse(row.content);
            if (!Array.isArray(parsed)) continue;
            blocks = parsed;
          } catch {
            continue;
          }

          // Count image/file blocks that contain inline base64 data.
          const inlineBlocks = blocks.filter(
            (b) =>
              typeof b === "object" &&
              b !== null &&
              (isInlineImageBlock(b as Record<string, unknown>) ||
                isInlineFileBlock(b as Record<string, unknown>)),
          );
          if (inlineBlocks.length === 0) continue;

          // Load the attachment links ordered by position.
          const attachmentLinks = raw
            .query(
              `SELECT ma.attachment_id, ma.position,
                      a.mime_type, a.original_filename, a.size_bytes
               FROM message_attachments ma
               JOIN attachments a ON a.id = ma.attachment_id
               WHERE ma.message_id = ?
               ORDER BY ma.position`,
            )
            .all(row.id) as AttachmentRow[];

          // Guard: attachment count must match inline block count for a safe rewrite.
          if (attachmentLinks.length !== inlineBlocks.length) continue;

          // Replace each inline block with the corresponding attachment ref.
          let attachIdx = 0;
          let changed = false;
          const rewritten = blocks.map((b) => {
            if (
              typeof b !== "object" ||
              b === null ||
              (!isInlineImageBlock(b as Record<string, unknown>) &&
                !isInlineFileBlock(b as Record<string, unknown>))
            ) {
              return b;
            }

            const att = attachmentLinks[attachIdx++];
            if (!att) return b; // safety: bail if index runs out

            changed = true;
            const block = b as Record<string, unknown>;

            if (block.type === "image") {
              return {
                type: "image_ref",
                source: {
                  attachment_id: att.attachment_id,
                  media_type: att.mime_type,
                },
                size_bytes: att.size_bytes,
              };
            }
            // file block
            return {
              type: "file_ref",
              source: {
                attachment_id: att.attachment_id,
                media_type: att.mime_type,
                filename: att.original_filename,
              },
              extracted_text:
                typeof block.extracted_text === "string"
                  ? block.extracted_text
                  : undefined,
              size_bytes: att.size_bytes,
            };
          });

          if (!changed) continue;

          raw
            .query(`UPDATE messages SET content = ? WHERE id = ?`)
            .run(JSON.stringify(rewritten), row.id);
          totalRewritten++;
        }
      }

      if (totalRewritten > 0) {
        console.log(
          `[backfill-attachment-refs] Rewrote ${totalRewritten} user messages to use attachment ref blocks`,
        );
      }
    },
  );
}

/**
 * Reverse: no-op.
 *
 * The forward migration rewrote persisted message JSON to remove inline
 * base64 bytes in favour of attachment IDs. Reversing would require
 * re-reading each attachment file and re-embedding the base64, which is
 * a destructive expansion (increases DB size) and not worth implementing
 * since old code can still read image_ref / file_ref blocks gracefully
 * (they fall through to the default case in all switches).
 */
export function migrateBackfillUserMessageAttachmentRefsDown(
  _database: DrizzleDb,
): void {
  // No-op — see comment above.
}
