/**
 * Platform-baseline Gmail digest generator.
 *
 * Produces a mechanical "N new emails" digest FeedItem for the home
 * activity feed. This is the first platform-authored feed source —
 * it runs on a schedule (see `feed-scheduler.ts` for the Phase-5
 * stopgap) and writes a digest item via the feed writer.
 *
 * Design notes:
 *
 *   - No LLM calls. Title and summary are purely mechanical so this
 *     path stays cheap and deterministic. Assistant-authored nudges
 *     can override a platform digest for the same `(type, source)`
 *     pair via the feed writer's hybrid-authoring resolver (see
 *     `feed-writer.ts`).
 *   - No direct Gmail API fetches. The count is read from whatever
 *     integration cache already exists. A dependency-injected count
 *     source keeps the function testable and leaves room for the real
 *     integration wiring to land in a follow-up PR.
 *   - One-per-source replacement is handled by the writer — a fresh
 *     digest automatically replaces any prior Gmail digest in place
 *     on each call.
 *   - `minTimeAway: 3600` (1 hour) avoids showing the digest to users
 *     who've only briefly stepped away. Priority `40` is mid-tier so
 *     assistant-authored items naturally win on the sort.
 */

import { randomUUID } from "node:crypto";

import { getLogger } from "../util/logger.js";
import type { FeedItem } from "./feed-types.js";
import { appendFeedItem } from "./feed-writer.js";

const log = getLogger("platform-gmail-digest");

/**
 * Count source for pending Gmail emails. Kept as an injectable
 * dependency so tests can supply a deterministic number and so the
 * real wiring (an integration cache / event bus) can be swapped in
 * without touching this module.
 *
 * The default source returns 0 — there is no persistent, platform-
 * wide Gmail inbox count tracked in the daemon today, so the default
 * path is a no-op until a real count source is wired in.
 */
export type GmailCountSource = () => Promise<number>;

async function defaultGmailCountSource(): Promise<number> {
  // No platform-wide Gmail inbox count exists in the daemon yet.
  // Callers pass an explicit `countSource` from whatever integration
  // state is appropriate for their context (tests, watcher store,
  // future integration event bus, etc.).
  return 0;
}

/**
 * Build and append a platform-baseline Gmail digest feed item.
 *
 * Returns `null` when the count is 0 (no-op; we do not write an
 * empty digest). Otherwise returns the constructed `FeedItem` after
 * successfully enqueueing it via `appendFeedItem`.
 *
 * Never throws — all failures degrade to a warn-log so the caller
 * (a scheduler tick) can fire-and-forget without a try/catch.
 */
export async function generateGmailDigest(
  now: Date,
  countSource: GmailCountSource = defaultGmailCountSource,
): Promise<FeedItem | null> {
  let count: number;
  try {
    count = await countSource();
  } catch (err) {
    log.warn({ err }, "Gmail count source threw; skipping digest");
    return null;
  }

  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }

  const flooredCount = Math.floor(count);
  const timestamp = now.toISOString();

  const item: FeedItem = {
    id: randomUUID(),
    type: "digest",
    source: "gmail",
    author: "platform",
    title: `${flooredCount} new email${flooredCount === 1 ? "" : "s"}`,
    summary: `Since your last check-in`,
    priority: 40,
    minTimeAway: 3600,
    timestamp,
    createdAt: timestamp,
    status: "new",
  };

  try {
    await appendFeedItem(item);
  } catch (err) {
    log.warn({ err }, "Failed to append Gmail digest to feed");
    return null;
  }

  return item;
}
