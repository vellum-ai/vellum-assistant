/**
 * Workspace migration `138-backfill-home-feed-titles`.
 *
 * Gives every item in `<workspace>/data/home-feed.json` a non-empty
 * `title`. The feed writer sets one on every item it appends; stored
 * items that lack the field get a headline derived from their own
 * `summary`, so the field is uniformly present across the file.
 *
 * Behaviour:
 *   - Missing file, unparseable JSON, or a non-object root: no-op.
 *   - Item that already has a non-empty `title`: untouched.
 *   - Item without one: title derived from `summary` (markdown and
 *     newlines flattened, first sentence, capped at 60 characters with
 *     an ellipsis).
 *   - `version`, `updatedAt`, and every other item field are preserved.
 *
 * Idempotent: a second run finds every item titled, so it writes
 * nothing. The runner's checkpoint also skips re-runs, but this in-file
 * guard keeps the migration safe even if the checkpoint is wiped.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-138-backfill-home-feed-titles");

const HOME_FEED_RELATIVE_PATH = join("data", "home-feed.json");

/**
 * Matches `NOTIFICATION_TITLE_MAX_LENGTH` in
 * `notifications/notification-utils.ts`, the cap on the headline the feed
 * writer derives from a summary, so a backfilled item and a freshly
 * written one with the same summary carry the same title.
 */
const MAX_TITLE_LENGTH = 60;

/**
 * The persisted item fields this migration touches. Inlined rather than
 * imported from `home/feed-types.ts` so the migration stays
 * self-contained per the migrations AGENTS.md.
 */
interface PersistedFeedItem {
  /** Missing, empty, or non-string on the items repaired here. */
  title?: unknown;
  /** Source text for the derived title. */
  summary?: unknown;
  /** Every other persisted field is carried through untouched. */
  [key: string]: unknown;
}

export const backfillHomeFeedTitlesMigration: WorkspaceMigration = {
  id: "138-backfill-home-feed-titles",
  description:
    "Backfill a summary-derived title on home-feed items that lack one",

  run(workspaceDir: string): void {
    const path = join(workspaceDir, HOME_FEED_RELATIVE_PATH);
    if (!existsSync(path)) {
      return;
    }

    // Read outside the parse catch: a transient filesystem error (EIO,
    // EACCES) must reach the runner so the migration retries, while
    // malformed JSON is a permanent state this migration cannot repair.
    const rawText = readFileSync(path, "utf-8");

    let feed: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText);
      if (!isPlainObject(parsed)) {
        return;
      }
      feed = parsed;
    } catch (err) {
      log.warn(
        { err, path },
        "Failed to parse home-feed.json; skipping title backfill",
      );
      return;
    }

    const rawItems = Array.isArray(feed.items) ? feed.items : [];
    let backfilled = 0;
    for (const entry of rawItems) {
      if (!isPlainObject(entry)) {
        continue;
      }
      const item: PersistedFeedItem = entry;
      if (typeof item.title === "string" && item.title.trim().length > 0) {
        continue;
      }
      if (typeof item.summary !== "string") {
        continue;
      }
      const derived = deriveTitle(item.summary);
      if (derived.length === 0) {
        continue;
      }
      item.title = derived;
      backfilled++;
    }

    if (backfilled === 0) {
      return;
    }

    // Write-then-rename so an interrupted write cannot leave
    // home-feed.json truncated: the reader treats an unparseable file as
    // an empty feed, so a torn in-place write would discard the user's
    // notification history outright.
    const tmpPath = `${path}.migration-138.tmp`;
    writeFileSync(tmpPath, JSON.stringify(feed, null, 2), "utf-8");
    renameSync(tmpPath, path);

    log.info({ path, backfilled }, "Backfilled titles on home-feed items");
  },

  // Deriving a title from the summary is idempotent, so a transient
  // failure (full disk, I/O error) is safe to retry on later startups.
  retryFailedCheckpoint: true,

  down(_workspaceDir: string): void {
    // Forward-only: a derived title is indistinguishable from an
    // authored one, so there is nothing safe to strip back out.
  },
};

// ---------------------------------------------------------------------------
// Helpers: self-contained per the workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

/**
 * Derive a short headline from a summary: the markdown is flattened to a
 * single line of plain text, the first sentence is taken when the text
 * has a terminator, and the result is capped at `MAX_TITLE_LENGTH`
 * characters with an ellipsis. Returns "" when nothing usable survives.
 *
 * Inlined rather than imported from the notification pipeline so the
 * migration stays self-contained per the migrations AGENTS.md.
 */
function deriveTitle(summary: string): string {
  const text = flattenToPlainText(summary);
  const firstSentenceEnd = text.search(/[.!?](\s|$)/);
  const candidate =
    firstSentenceEnd > 0 ? text.slice(0, firstSentenceEnd + 1) : text;
  return candidate.length > MAX_TITLE_LENGTH
    ? candidate.slice(0, MAX_TITLE_LENGTH).trim() + "…"
    : candidate.trim();
}

/**
 * Reduce markdown-rich summary text to a single line of plain prose:
 * block structure (code fences, headings, blockquotes, list markers) is
 * dropped, inline formatting is unwrapped, and every run of whitespace,
 * newlines included, collapses to one space.
 */
function flattenToPlainText(text: string): string {
  return text
    .replace(/^\s{0,3}(?:```|~~~).*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
