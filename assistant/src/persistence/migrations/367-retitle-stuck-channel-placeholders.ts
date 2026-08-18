import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { tableExists, tableHasColumn } from "./schema-introspection.js";

const log = getLogger("migration-367");

/** Title every conversation is minted with until something replaces it. */
const PLACEHOLDER_TITLE = "Generating title...";

/** `conversations.is_auto_title` value for a deterministic, upgradeable title. */
const AUTO_TITLE_DETERMINISTIC = 2;

/**
 * A placeholder younger than this may still be mid-flight: its first turn or
 * its LLM title call has not landed yet. Only older rows are treated as stuck.
 */
const STUCK_MIN_AGE_MS = 60 * 60 * 1000;

/** Rows examined per pass; keyset-paginated on `conversations.id`. */
const BATCH_SIZE = 500;

/** Content the Slack reaction persister writes; never shown to the model. */
const REACTION_SENTINEL = "[reaction]";

/**
 * Prefix of every channel conversation key
 * (`asst:self:<channel>:<chat>[:thread:<id>]`). Frozen copy of the format
 * `buildScopedConversationKey` writes.
 */
const CHANNEL_KEY_PREFIX = "asst:self:";

/**
 * Display labels for the channels that mint conversations through the inbound
 * pipeline. Frozen copy of the channel card labels; a key segment that is not
 * listed here (for example `voice`) is not channel evidence.
 */
const CHANNEL_LABELS: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  email: "Email",
  a2a: "A2A",
  plugin: "Plugin",
};

interface CandidateRow {
  id: string;
  event_channel: string | null;
  channel_key: string | null;
}

interface MessageShape {
  has_content: number;
  has_reaction: number;
}

function channelFromKey(key: string | null): string | null {
  if (!key || !key.startsWith(CHANNEL_KEY_PREFIX)) {
    return null;
  }
  const segment = key.slice(CHANNEL_KEY_PREFIX.length).split(":")[0] ?? "";
  return segment in CHANNEL_LABELS ? segment : null;
}

function channelLabel(channel: string): string {
  const label = CHANNEL_LABELS[channel];
  if (label) {
    return label;
  }
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

/**
 * Give every stuck channel conversation a deterministic title.
 *
 * A channel conversation is minted with the "Generating title..." placeholder
 * and only an agent turn's title hooks replace it. Inbounds that end before a
 * turn (admission deny, disk-pressure block, stale button, secret block,
 * intercepted guardian reply, dead-letter, reactions) leave the placeholder
 * in place forever, so the sidebar fills with rows named "Generating
 * title...". The live pipeline titles a conversation at the mint; this
 * migration repairs the rows minted before that.
 *
 * Scope: rows still on the placeholder, older than {@link STUCK_MIN_AGE_MS},
 * with channel-origin evidence (an inbound event row, or a conversation key
 * naming a known channel). Everything else, including web and background
 * conversations on the placeholder, is left alone.
 *
 * Classification by the conversation's messages:
 * - only reaction sentinel rows: `<Channel> reaction`, archived (nothing to
 *   read in it);
 * - no rows at all: `New <Channel> message`, archived;
 * - anything else: `New <Channel> message`, left in place.
 *
 * Every retitle writes `is_auto_title = 2` so the next genuine turn's title
 * hook still upgrades it to an LLM title. `updated_at` is deliberately not
 * bumped: these are old rows and a retitle must not resurface them at the top
 * of the sidebar. Never deletes.
 *
 * Idempotent: a retitled row no longer matches the placeholder predicate, so
 * a re-run finds nothing. Guards on every table and column it touches so a
 * database that predates any of them no-ops.
 */
export function migrateRetitleStuckChannelPlaceholders(
  database: DrizzleDb,
): void {
  if (
    !tableExists(database, "conversations") ||
    !tableExists(database, "messages") ||
    !tableExists(database, "channel_inbound_events") ||
    !tableExists(database, "conversation_keys") ||
    !tableHasColumn(database, "conversations", "is_auto_title") ||
    !tableHasColumn(database, "conversations", "archived_at")
  ) {
    return;
  }

  const raw = getSqliteFrom(database);
  const cutoff = Date.now() - STUCK_MIN_AGE_MS;

  const selectCandidates = raw.query(/*sql*/ `
    SELECT
      c.id AS id,
      (
        SELECT e.source_channel FROM channel_inbound_events e
        WHERE e.conversation_id = c.id
        ORDER BY e.created_at ASC
        LIMIT 1
      ) AS event_channel,
      (
        SELECT k.conversation_key FROM conversation_keys k
        WHERE k.conversation_id = c.id AND k.conversation_key LIKE ?
        ORDER BY k.created_at ASC
        LIMIT 1
      ) AS channel_key
    FROM conversations c
    WHERE c.title = ?
      AND c.created_at < ?
      AND c.id > ?
      AND (
        EXISTS (
          SELECT 1 FROM channel_inbound_events e WHERE e.conversation_id = c.id
        )
        OR EXISTS (
          SELECT 1 FROM conversation_keys k
          WHERE k.conversation_id = c.id AND k.conversation_key LIKE ?
        )
      )
    ORDER BY c.id ASC
    LIMIT ?
  `);
  const selectMessageShape = raw.query(/*sql*/ `
    SELECT
      EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = ? AND m.content <> ?
      ) AS has_content,
      EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = ? AND m.content = ?
      ) AS has_reaction
  `);
  const retitle = raw.prepare(/*sql*/ `
    UPDATE conversations SET title = ?, is_auto_title = ? WHERE id = ?
  `);
  const retitleAndArchive = raw.prepare(/*sql*/ `
    UPDATE conversations
    SET title = ?, is_auto_title = ?, archived_at = COALESCE(archived_at, ?)
    WHERE id = ?
  `);
  const keyPattern = `${CHANNEL_KEY_PREFIX}%`;

  let retitled = 0;
  let archived = 0;
  let skipped = 0;
  const applyBatch = raw.transaction((rows: CandidateRow[]) => {
    for (const row of rows) {
      const channel = channelFromKey(row.channel_key) ?? row.event_channel;
      if (!channel) {
        skipped++;
        continue;
      }
      const label = channelLabel(channel);
      const shape = selectMessageShape.get(
        row.id,
        REACTION_SENTINEL,
        row.id,
        REACTION_SENTINEL,
      ) as MessageShape;
      if (shape.has_content) {
        retitle.run(`New ${label} message`, AUTO_TITLE_DETERMINISTIC, row.id);
        retitled++;
        continue;
      }
      const title = shape.has_reaction
        ? `${label} reaction`
        : `New ${label} message`;
      retitleAndArchive.run(
        title,
        AUTO_TITLE_DETERMINISTIC,
        Date.now(),
        row.id,
      );
      retitled++;
      archived++;
    }
  });

  let lastId = "";
  for (;;) {
    const rows = selectCandidates.all(
      keyPattern,
      PLACEHOLDER_TITLE,
      cutoff,
      lastId,
      keyPattern,
      BATCH_SIZE,
    ) as CandidateRow[];
    if (rows.length === 0) {
      break;
    }
    lastId = rows[rows.length - 1]!.id;
    applyBatch(rows);
    if (rows.length < BATCH_SIZE) {
      break;
    }
  }

  if (retitled > 0 || skipped > 0) {
    log.info(
      { retitled, archived, skipped },
      "Retitled stuck channel conversation placeholders",
    );
  }
}
