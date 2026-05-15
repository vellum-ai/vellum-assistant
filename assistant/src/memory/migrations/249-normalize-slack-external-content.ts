import { readSlackMetadata } from "../../messaging/providers/slack/message-metadata.js";
import {
  parseExternalContentEnvelope,
  unwrapExternalContentForDisplay,
} from "../../security/untrusted-content.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_normalize_slack_external_content_v1";
const BATCH_SIZE = 100;

interface CandidateMessageRow {
  rowid: number;
  id: string;
  content: string;
  metadata: string;
}

interface NormalizedMessageRow {
  content: string;
  metadata: string;
}

export function migrateNormalizeSlackExternalContent(
  database: DrizzleDb,
): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const tableExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
      )
      .get();
    if (!tableExists) return;

    let lastRowid = 0;

    for (;;) {
      const rows = raw
        .query(
          /*sql*/ `
            SELECT rowid, id, content, metadata
            FROM messages
            WHERE rowid > ?
              AND content LIKE '%<external_content%'
              AND metadata LIKE '%"slackMeta"%'
            ORDER BY rowid
            LIMIT ?
          `,
        )
        .all(lastRowid, BATCH_SIZE) as CandidateMessageRow[];

      if (rows.length === 0) break;

      for (const row of rows) {
        lastRowid = row.rowid;
        const normalized = normalizeSlackMessageRow(row);
        if (!normalized) continue;

        raw
          .query(`UPDATE messages SET content = ?, metadata = ? WHERE id = ?`)
          .run(normalized.content, normalized.metadata, row.id);
      }
    }
  });
}

export function downNormalizeSlackExternalContent(_database: DrizzleDb): void {
  // Irreversible by design: this migration discards redundant persisted
  // wrappers and leaves runtime assembly responsible for model boundaries.
}

function normalizeSlackMessageRow(
  row: CandidateMessageRow,
): NormalizedMessageRow | null {
  const metadata = parseSlackMetadataEnvelope(row.metadata);
  if (!metadata) return null;

  const normalizedContent = normalizeMessageContent(row.content);
  if (normalizedContent === null) return null;

  if (!Object.prototype.hasOwnProperty.call(metadata, "provenanceTrustClass")) {
    metadata.provenanceTrustClass = "unknown";
  }

  return {
    content: normalizedContent,
    metadata: JSON.stringify(metadata),
  };
}

function parseSlackMetadataEnvelope(
  rawMetadata: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const metadata = parsed as Record<string, unknown>;
  if (typeof metadata.slackMeta !== "string") return null;
  if (!readSlackMetadata(metadata.slackMeta)) return null;
  return metadata;
}

function normalizeMessageContent(content: string): string | null {
  const wholeEnvelope = parseExternalContentEnvelope(content);
  if (wholeEnvelope) {
    return wholeEnvelope.content;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  let changed = false;
  const normalizedBlocks = parsed.map((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      return block;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") {
      return block;
    }

    const unwrapped = unwrapExternalContentForDisplay(record.text);
    if (unwrapped === record.text) {
      return block;
    }

    changed = true;
    return { ...record, text: unwrapped };
  });

  return changed ? JSON.stringify(normalizedBlocks) : null;
}
