/**
 * Home activity feed writer.
 *
 * Owns `<workspace>/data/home-feed.json`, the daemon-side source of
 * truth for the macOS Home page activity feed. Handles the merge
 * semantics defined by the TDD / plan:
 *
 *   - Digest replacement: at most one digest per `source`. A fresh
 *     digest for a source replaces any prior digest for the same
 *     source in place.
 *   - Thread in-place update: if an incoming `thread` item shares its
 *     `id` with an existing item, replace that item while preserving
 *     its array position so the UI does not jitter on updates.
 *   - Author resolution: for matching `(type, source)` pairs the
 *     hybrid-authoring precedence is `assistant` beats `platform` —
 *     an assistant item overwrites an existing platform item for the
 *     same pair, but a platform item never overwrites an existing
 *     assistant item (no-op).
 *   - Action auto-fade: when an `action` item is appended without an
 *     explicit `expiresAt`, the writer fills it in as
 *     `createdAt + 24h` so stale actions fall off on next read.
 *   - TTL filter on read: `readHomeFeed` drops any item whose
 *     `expiresAt` is in the past. This is a stateless sweep — the
 *     writer does not rewrite the file on read, so concurrent reads
 *     never race the writer.
 *
 * Concurrent writers are coalesced with the exact same "latest wins"
 * pattern as `relationship-state-writer.ts`: at most one compute+write
 * runs at a time, and overlapping calls during an in-flight write all
 * resolve off a single tail write that reflects the final state.
 *
 * Each successful write publishes a `home_feed_updated` SSE event via
 * the in-process `assistantEventHub`, carrying the post-filter count
 * of items with `status === "new"` so subscribers can update unread
 * badges without a full refetch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";
import {
  type FeedItem,
  type FeedItemStatus,
  type HomeFeedFile,
  parseFeedFile,
} from "./feed-types.js";

const log = getLogger("home-feed-writer");

/** Filename for the on-disk home feed. Lives under the workspace data dir. */
export const HOME_FEED_FILENAME = "home-feed.json";

/** On-disk file-format version. Bump + migrate if the shape changes. */
export const HOME_FEED_VERSION = 1;

/**
 * Action items without an explicit `expiresAt` auto-fade this many
 * milliseconds after their `createdAt` timestamp. 24 hours matches the
 * TDD default.
 */
const ACTION_AUTO_FADE_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical path to the home-feed snapshot
 * (`<workspace>/data/home-feed.json`).
 */
export function getHomeFeedPath(): string {
  return join(getDataDir(), HOME_FEED_FILENAME);
}

/**
 * Read the on-disk feed file, applying the stateless TTL filter.
 *
 * Returns an empty `HomeFeedFile` when the file is missing, unreadable,
 * or fails Zod validation — callers never see a throw from this path.
 * Items whose `expiresAt` is in the past are dropped from the returned
 * `items` array but are NOT rewritten to disk; the next append cycle
 * will persist the post-filter view naturally.
 */
export function readHomeFeed(): HomeFeedFile {
  const path = getHomeFeedPath();
  const empty: HomeFeedFile = {
    version: HOME_FEED_VERSION,
    items: [],
    updatedAt: new Date(0).toISOString(),
  };

  if (!existsSync(path)) {
    return empty;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log.warn({ err, path }, "Failed to read home-feed.json; returning empty");
    return empty;
  }

  let parsed: HomeFeedFile;
  try {
    parsed = parseFeedFile(raw);
  } catch (err) {
    log.warn(
      { err, path },
      "home-feed.json failed schema validation; returning empty",
    );
    return empty;
  }

  const now = Date.now();
  const items = parsed.items.filter((item) => !isExpired(item, now));
  return {
    version: parsed.version,
    items,
    updatedAt: parsed.updatedAt,
  };
}

/**
 * Append (or merge) a single feed item and persist the result.
 *
 * See the module comment for the precise merge semantics. Never
 * throws — all failures degrade to a warn-log so fire-and-forget
 * callers in the daemon don't need a try/catch wrapper. Concurrent
 * calls are coalesced via the in-module `writeInFlight` / `writeDirty`
 * pattern so at most one write is in flight at a time.
 */
export async function appendFeedItem(item: FeedItem): Promise<void> {
  pendingAppends.push(item);
  return scheduleWrite();
}

/**
 * Update the `status` field of a single feed item by id.
 *
 * Returns the updated `FeedItem` on success, or `null` if no item with
 * the given id exists. This is the path the HTTP route uses when the
 * client marks an item as `"seen"` or `"acted_on"`. Concurrent patches
 * go through the same coalescing queue as `appendFeedItem` so two
 * overlapping status flips can't race each other.
 *
 * The patch is applied inside `runWrite()` so the existence check
 * reads from the same state snapshot the mutation will land on —
 * callers never observe a "phantom success" where we return an
 * updated item for an id that no longer exists on disk by the time
 * the queued write runs.
 */
export async function patchFeedItemStatus(
  id: string,
  status: FeedItemStatus,
): Promise<FeedItem | null> {
  let resolveResult!: (value: FeedItem | null) => void;
  const resultPromise = new Promise<FeedItem | null>((resolve) => {
    resolveResult = resolve;
  });
  pendingPatches.push({ id, status, resolve: resolveResult });
  void scheduleWrite();
  return resultPromise;
}

// ─── Internal: coalescing queue ────────────────────────────────────────

/**
 * Pending operations that land in the next coalesced write cycle.
 * Appends and patches drain together so overlapping callers share a
 * single compute+write tail.
 */
const pendingAppends: FeedItem[] = [];
const pendingPatches: Array<{
  id: string;
  status: FeedItemStatus;
  resolve: (value: FeedItem | null) => void;
}> = [];

let writeInFlight: Promise<void> | null = null;
let writeDirty = false;

/**
 * Enqueue a write cycle. Mirrors the `relationship-state-writer.ts`
 * coalescing pattern exactly: the first caller kicks off a run; any
 * callers that arrive during an in-flight run mark dirty and resolve
 * off the same tail promise, so N overlapping callers produce at most
 * two runs (the initial + one coalesced tail).
 */
function scheduleWrite(): Promise<void> {
  if (writeInFlight) {
    writeDirty = true;
    return writeInFlight;
  }
  writeInFlight = (async () => {
    try {
      await runWrite();
      while (writeDirty) {
        writeDirty = false;
        await runWrite();
      }
    } finally {
      writeInFlight = null;
    }
  })();
  return writeInFlight;
}

/**
 * Drain the pending-operations queue into a fresh on-disk snapshot
 * and publish the SSE event. Never throws — the write error is caught
 * + logged so the coalescing loop can still move on to the next cycle.
 */
async function runWrite(): Promise<void> {
  const appendsToApply = pendingAppends.splice(0, pendingAppends.length);
  const patchesToApply = pendingPatches.splice(0, pendingPatches.length);

  const current = readHomeFeed();
  let items = current.items.slice();

  for (const incoming of appendsToApply) {
    items = mergeIncoming(items, incoming);
  }

  // Track the per-patch result so callers can distinguish an update
  // from an unknown-id no-op. We collect resolvers first and fire them
  // after the write lands so the resolved `FeedItem` matches on-disk
  // state exactly.
  const patchResults: Array<{
    resolve: (v: FeedItem | null) => void;
    value: FeedItem | null;
  }> = [];
  for (const patch of patchesToApply) {
    const idx = items.findIndex((i) => i.id === patch.id);
    if (idx === -1) {
      patchResults.push({ resolve: patch.resolve, value: null });
      continue;
    }
    const updated: FeedItem = { ...items[idx]!, status: patch.status };
    items[idx] = updated;
    patchResults.push({ resolve: patch.resolve, value: updated });
  }

  items.sort(compareFeedItems);

  const updatedAt = new Date().toISOString();
  const next: HomeFeedFile = {
    version: HOME_FEED_VERSION,
    items,
    updatedAt,
  };

  let wrote = false;
  try {
    const path = getHomeFeedPath();
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
    wrote = true;
    log.info({ path, items: items.length }, "Wrote home-feed.json");
  } catch (err) {
    log.warn({ err }, "Failed to write home-feed.json");
  }

  if (wrote) {
    const newItemCount = items.filter((i) => i.status === "new").length;
    publishHomeFeedUpdated(updatedAt, newItemCount);
  }

  // Resolve pending patch promises AFTER we've emitted the SSE event
  // so callers awaiting `patchFeedItemStatus` observe a fully
  // consistent world: the on-disk file, the SSE event, and the
  // returned `FeedItem` all reflect the same write.
  //
  // If the write failed, resolve all patch promises with `null` — the
  // state was not persisted, and callers (e.g. HTTP route handlers)
  // must not report success when the underlying write failed.
  for (const { resolve, value } of patchResults) {
    resolve(wrote ? value : null);
  }
}

/**
 * Apply the merge semantics for a single incoming item against the
 * current item list and return a new list. Pure function — the input
 * array is not mutated.
 */
function mergeIncoming(items: FeedItem[], incoming: FeedItem): FeedItem[] {
  const withDefaults = applyActionAutoFade(incoming);

  // Digest replacement: one digest per source wins.
  if (withDefaults.type === "digest" && withDefaults.source) {
    const filtered = items.filter(
      (i) => !(i.type === "digest" && i.source === withDefaults.source),
    );
    filtered.push(withDefaults);
    return filtered;
  }

  // Thread in-place update: same id wins, preserve position.
  if (withDefaults.type === "thread") {
    const idx = items.findIndex(
      (i) => i.type === "thread" && i.id === withDefaults.id,
    );
    if (idx !== -1) {
      const copy = items.slice();
      copy[idx] = withDefaults;
      return copy;
    }
  }

  // Author resolution: for matching (type, source) pairs, assistant
  // beats platform. A platform-authored incoming item against an
  // existing assistant item is a no-op.
  if (withDefaults.source) {
    const existingIdx = items.findIndex(
      (i) => i.type === withDefaults.type && i.source === withDefaults.source,
    );
    if (existingIdx !== -1) {
      const existing = items[existingIdx]!;
      if (
        existing.author === "assistant" &&
        withDefaults.author === "platform"
      ) {
        // Platform can't overwrite assistant — no-op.
        return items;
      }
      if (
        existing.author === "platform" &&
        withDefaults.author === "assistant"
      ) {
        const copy = items.slice();
        copy[existingIdx] = withDefaults;
        return copy;
      }
    }
  }

  return [...items, withDefaults];
}

/**
 * Fill in the `expiresAt` field on action items that were appended
 * without one. Pure — returns the original reference untouched when no
 * auto-fade is needed so the common path avoids a copy.
 */
function applyActionAutoFade(item: FeedItem): FeedItem {
  if (item.type !== "action") return item;
  if (item.expiresAt) return item;
  const createdAtMs = Date.parse(item.createdAt);
  if (Number.isNaN(createdAtMs)) return item;
  const expiresAt = new Date(createdAtMs + ACTION_AUTO_FADE_MS).toISOString();
  return { ...item, expiresAt };
}

/**
 * Return `true` when the item has an `expiresAt` timestamp that is in
 * the past relative to the supplied `nowMs`. Items without
 * `expiresAt`, or with an unparseable value, are treated as not
 * expired (fail-open).
 */
function isExpired(item: FeedItem, nowMs: number): boolean {
  if (!item.expiresAt) return false;
  const expiresMs = Date.parse(item.expiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs <= nowMs;
}

/**
 * Sort comparator: priority DESC, then createdAt DESC. Matches the
 * ordering contract the UI expects so higher-priority and fresher
 * items sort to the top of the feed.
 */
function compareFeedItems(a: FeedItem, b: FeedItem): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const aMs = Date.parse(a.createdAt);
  const bMs = Date.parse(b.createdAt);
  if (Number.isNaN(aMs) && Number.isNaN(bMs)) return 0;
  if (Number.isNaN(aMs)) return 1;
  if (Number.isNaN(bMs)) return -1;
  return bMs - aMs;
}

/**
 * Publish a `home_feed_updated` event to the in-process hub. Wrapped
 * in a `.catch` so a subscriber rejection never bubbles up into the
 * writer coalescing loop.
 */
function publishHomeFeedUpdated(updatedAt: string, newItemCount: number): void {
  assistantEventHub
    .publish(
      buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
        type: "home_feed_updated",
        updatedAt,
        newItemCount,
      }),
    )
    .catch((err) => {
      log.warn({ err }, "Failed to publish home_feed_updated event");
    });
}
