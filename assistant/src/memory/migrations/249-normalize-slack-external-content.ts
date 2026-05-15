import {
  readSlackMetadata,
  type SlackMessageMetadata,
} from "../../messaging/providers/slack/message-metadata.js";
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
  role: string;
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
            SELECT rowid, id, role, content, metadata
            FROM messages
            WHERE rowid > ?
              AND metadata LIKE '%"slackMeta"%'
              AND (
                content LIKE '%<external_content%'
                OR metadata NOT LIKE '%"provenanceTrustClass"%'
              )
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
  const parsed = parseSlackMetadataEnvelope(row.metadata);
  if (!parsed) return null;

  const normalizedContent = normalizeMessageContent(row.content);
  if (normalizedContent !== null) {
    const { metadata } = parsed;
    if (
      !Object.prototype.hasOwnProperty.call(metadata, "provenanceTrustClass")
    ) {
      metadata.provenanceTrustClass = "unknown";
    }

    return {
      content: normalizedContent,
      metadata: JSON.stringify(metadata),
    };
  }

  if (isLegacyGuardianBackfillRow(row, parsed)) {
    const { metadata } = parsed;
    metadata.provenanceTrustClass = "guardian";
    if (
      !Object.prototype.hasOwnProperty.call(metadata, "provenanceSourceChannel")
    ) {
      metadata.provenanceSourceChannel = "slack";
    }

    return {
      content: row.content,
      metadata: JSON.stringify(metadata),
    };
  }

  return null;
}

function parseSlackMetadataEnvelope(rawMetadata: string): {
  metadata: Record<string, unknown>;
  slackMeta: SlackMessageMetadata;
} | null {
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
  const slackMeta = readSlackMetadata(metadata.slackMeta);
  if (!slackMeta) return null;
  return { metadata, slackMeta };
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

function isLegacyGuardianBackfillRow(
  row: CandidateMessageRow,
  parsed: {
    metadata: Record<string, unknown>;
    slackMeta: SlackMessageMetadata;
  },
): boolean {
  if (row.role !== "user") return false;
  if (parsed.slackMeta.eventKind !== "message") return false;
  if (
    Object.prototype.hasOwnProperty.call(
      parsed.metadata,
      "provenanceTrustClass",
    )
  ) {
    return false;
  }

  // Old live Slack turns were written with turn-channel metadata. Old
  // backfill rows were written directly with only `slackMeta`, and the old
  // backfill invariant was: non-guardian non-empty text was stored wrapped,
  // while guardian-authored non-empty text was stored raw. Only stamp the
  // non-empty raw-text case; attachment-only / empty rows stay conservative.
  if (
    Object.prototype.hasOwnProperty.call(parsed.metadata, "userMessageChannel")
  ) {
    return false;
  }

  return hasNonEmptyRawText(row.content);
}

function hasNonEmptyRawText(content: string): boolean {
  if (parseExternalContentEnvelope(content)) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.trim().length > 0;
  }

  if (typeof parsed === "string") {
    return parsed.trim().length > 0 && !parseExternalContentEnvelope(parsed);
  }

  if (!Array.isArray(parsed)) return false;

  return parsed.some((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      return false;
    }
    const text = (block as Record<string, unknown>).text;
    return (
      typeof text === "string" &&
      text.trim().length > 0 &&
      !parseExternalContentEnvelope(text)
    );
  });
}
