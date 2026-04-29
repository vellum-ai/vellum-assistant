/**
 * Workspace migration `061-home-feed-notification-only`.
 *
 * Rewrites `<workspace>/data/home-feed.json` from the legacy v1 schema
 * (mixed `nudge | digest | action | thread` types with `source`,
 * `author`, `minTimeAway` fields) into the collapsed v2 schema (single
 * `notification` type, no source/author/minTimeAway).
 *
 * Behaviour:
 *   - Missing file → no-op.
 *   - Malformed JSON → log and no-op (daemon startup must never block;
 *     the writer's `readHomeFeed()` already treats unreadable files as
 *     empty so the next append cycle naturally rewrites a clean file).
 *   - Already v2 → no-op (idempotent).
 *   - v1 (or any non-v2 shape with an `items` array): drop entries
 *     whose `type !== "action"` (legacy nudge/digest/thread items have
 *     no v2 analogue and weren't surfaced as live notifications anyway,
 *     per PR 15 of the home-notif-feed-revamp plan); for kept entries
 *     drop `source` / `author` / `minTimeAway` and rewrite `type` to
 *     `"notification"`. Persist as `{ version: 2, items, updatedAt }`.
 *
 * Idempotent: running the migration a second time on a v2 file is a
 * no-op. The runner's checkpoint also skips re-runs, but this in-file
 * guard keeps the migration safe even if the checkpoint is wiped.
 *
 * `down()` is a no-op — the legacy v1 fields (`source`, `author`,
 * `minTimeAway`, the four item types) were dropped during the
 * forward migration and cannot be recovered. Rolling back to v1 from
 * v2 would also leave the writer producing a shape the older code
 * cannot parse, so a real rollback would require reverting the writer
 * code in lockstep.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-061-home-feed-notification-only");

const HOME_FEED_RELATIVE_PATH = join("data", "home-feed.json");

/** v2 file format. Mirrors `HomeFeedFile` in `home/feed-types.ts`. */
interface V2HomeFeedFile {
  version: 2;
  items: V2FeedItem[];
  updatedAt: string;
}

/**
 * v2 item shape. Inlined rather than imported from `home/feed-types.ts`
 * so the migration stays self-contained — per AGENTS.md migrations
 * should minimise cross-module coupling so they remain stable as code
 * around them evolves.
 */
interface V2FeedItem {
  id: string;
  type: "notification";
  priority: number;
  title: string;
  summary: string;
  timestamp: string;
  status: string;
  expiresAt?: string;
  actions?: unknown[];
  urgency?: string;
  conversationId?: string;
  detailPanel?: unknown;
  createdAt: string;
}

export const homeFeedNotificationOnlyMigration: WorkspaceMigration = {
  id: "home-feed-notification-only-v2",
  description:
    "Rewrite home-feed.json into v2 schema (single 'notification' type)",

  run(workspaceDir: string): void {
    const path = join(workspaceDir, HOME_FEED_RELATIVE_PATH);
    if (!existsSync(path)) {
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      // Daemon startup must never block on a parse failure here. The
      // writer's read path also treats malformed files as empty, so
      // skipping the migration just means the next append cycle will
      // overwrite the file with a fresh v2 snapshot.
      log.warn(
        { err, path },
        "Failed to parse home-feed.json; skipping migration",
      );
      return;
    }

    if (!isPlainObject(raw)) {
      log.warn({ path }, "home-feed.json is not an object; skipping migration");
      return;
    }

    if (raw.version === 2) {
      // Already migrated.
      return;
    }

    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    const items: V2FeedItem[] = [];
    for (const entry of rawItems) {
      const migrated = migrateItem(entry);
      if (migrated) items.push(migrated);
    }

    const next: V2HomeFeedFile = {
      version: 2,
      items,
      updatedAt: new Date().toISOString(),
    };

    try {
      writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
      log.info(
        { path, items: items.length },
        "Rewrote home-feed.json to v2 schema",
      );
    } catch (err) {
      log.warn(
        { err, path },
        "Failed to write migrated home-feed.json; leaving prior file in place",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Lossy migration — legacy fields (source/author/minTimeAway and
    // nudge/digest/thread items) cannot be reconstructed. The writer
    // code itself only emits v2 now, so rolling back would also leave
    // the file in a shape the v1 reader could not parse without
    // reverting feed-writer.ts in lockstep.
  },
};

/**
 * Convert a single legacy item into a v2 item, or return `null` to
 * drop it. Only `type === "action"` items survive — legacy
 * nudge/digest/thread entries have no v2 analogue and were not
 * surfaced as live notifications by PR 4's wiring (only assistant-
 * authored `action` items reached the live feed via
 * `home-feed-side-effect.ts`).
 */
function migrateItem(entry: unknown): V2FeedItem | null {
  if (!isPlainObject(entry)) return null;
  if (entry.type !== "action") return null;

  // Required fields — fail-soft on missing critical strings rather
  // than throwing, so a single bad legacy entry does not lose the
  // rest of the items.
  if (
    typeof entry.id !== "string" ||
    typeof entry.title !== "string" ||
    typeof entry.summary !== "string" ||
    typeof entry.timestamp !== "string" ||
    typeof entry.createdAt !== "string"
  ) {
    return null;
  }
  const priority =
    typeof entry.priority === "number" && Number.isInteger(entry.priority)
      ? entry.priority
      : 50;
  const status = typeof entry.status === "string" ? entry.status : "new";

  const out: V2FeedItem = {
    id: entry.id,
    type: "notification",
    priority,
    title: entry.title,
    summary: entry.summary,
    timestamp: entry.timestamp,
    status,
    createdAt: entry.createdAt,
  };
  if (typeof entry.expiresAt === "string") out.expiresAt = entry.expiresAt;
  if (Array.isArray(entry.actions)) out.actions = entry.actions;
  if (typeof entry.urgency === "string") out.urgency = entry.urgency;
  if (typeof entry.conversationId === "string") {
    out.conversationId = entry.conversationId;
  }
  if (isPlainObject(entry.detailPanel)) out.detailPanel = entry.detailPanel;
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
