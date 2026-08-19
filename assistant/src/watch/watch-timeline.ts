/**
 * The timeline a watch session writes: what the user narrated, and what was on
 * their screen while they narrated it.
 *
 * The timeline is its own store, not conversation history. A session produces
 * hundreds of entries with no assistant turn between them, which is a shape
 * message history cannot hold: providers require strict user/assistant
 * alternation, so history repair merges consecutive user messages into one
 * before every provider call, and every per-message bound downstream of that
 * merge (screenshot retention, AX-tree compaction) then sees a single message
 * and has nothing left to bound. Keeping entries in a table sidesteps that
 * entirely: nothing about a timeline touches turn-shaped machinery, and the
 * only text that reaches a model is the summary `renderWatchTimeline`
 * composes when the retrospective asks for it.
 *
 * Ordering is the property the retrospective depends on and the one arrival
 * order does not give for free: a narration final and the observation it
 * triggered are two independent async writes. Every entry carries `atMs`, its
 * offset from the start of the session, and reads order by it, so the
 * retrospective gets one interleaved timeline no matter which write landed
 * first.
 *
 * A screenshot lives in the row it belongs to, so an entry has one home and
 * one lifetime and a purge is a single `DELETE`. The frames afford that:
 * `attachScreenshot` is caller-gated, and the host captures at 960x540
 * (`HostCuExecutor.swift`), which is tens of kilobytes of JPEG rather than the
 * megabytes a full-resolution frame would be. Reads that only want the text
 * select around the column, so a session's pixels reach memory only when a
 * caller asks for a specific frame through {@link readWatchScreenshot}.
 *
 * Deletion needs no coordination beyond ordering. An append runs to completion
 * in one synchronous step, so nothing can land between its existence check and
 * its insert; every purge runs after the conversation rows it covers are
 * already gone. An append therefore either finishes before the purge, and is
 * swept by it, or starts after it and is refused by
 * {@link conversationStillExists}.
 *
 * A purge that never ran is not permanent. Nothing cascades into this table, so
 * a failed purge or a crash between the conversation delete and the purge would
 * otherwise strand frames of the user's screen for good;
 * {@link sweepOrphanedWatchTimelineEntries} deletes entries whose conversation
 * is gone, and reclaims them on the next startup or maintenance pass.
 */

import { randomUUID } from "node:crypto";

import {
  count,
  desc,
  eq,
  inArray,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";

import { escapeAxTreeContent } from "../context/outbound-sanitize.js";
import { getDb } from "../persistence/db-connection.js";
import { conversations } from "../persistence/schema/conversations.js";
import { watchTimelineEntries } from "../persistence/schema/watch.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("watch-timeline");

const NARRATION_LABEL = "narration:";
const OBSERVATION_LABEL = "screen:";

/** The format the host captures a watch screenshot in. */
export const WATCH_SCREENSHOT_MIME = "image/jpeg";

/**
 * Bytes of screenshot a single entry may carry.
 *
 * The host captures at 960x540 (`HostCuExecutor.swift`), which lands a JPEG
 * around 50-150 KB, so the cap is an order of magnitude of headroom over an
 * ordinary frame and exists to bound the pathological one. A frame over it is
 * dropped rather than stored, on the same terms as a frame that failed to
 * decode: the entry keeps its tree and its diff, and an entry that had nothing
 * else is refused.
 */
const MAX_SCREENSHOT_BYTES = 2_000_000;

/** Stands in for an AX tree the render bound left out. */
const AX_TREE_OMITTED = "<ax-tree-omitted />";

/**
 * Stands in for a screen the host captured but could not enumerate.
 *
 * The macOS host falls back to a bare screenshot whenever there is no focused
 * window (`HostCuExecutor.swift`), so an observation with pixels and no tree is
 * an expected shape rather than a broken one. The marker is what tells the
 * retrospective it is looking at a screen it can see but not read.
 */
const AX_TREE_UNAVAILABLE = "<ax-tree-unavailable />";

/** Notes that an entry's moment is also available as an image. */
const SCREENSHOT_NOTE = "a screenshot of this moment was captured.";

/** Separates one rendered entry from the next. */
const BLOCK_SEPARATOR = "\n\n";

/** Marks content the byte budget cut short. */
const TRUNCATION_MARKER = "[truncated]";

/**
 * Bytes an entry needs before it is worth rendering at all. A block clipped
 * below this says nothing its offset prefix does not, so the render stops
 * instead and reports the loss through `truncated`.
 */
const MIN_ENTRY_BYTES = 256;

/**
 * Bytes an AX tree needs before it is spelled out. Below it the tree collapses
 * to {@link AX_TREE_OMITTED}, which costs less than a tree clipped after its
 * first few elements and reads as the deliberate omission it is.
 */
const MIN_AX_TREE_BYTES = 256;

/**
 * Entries rendered by default, counted back from the most recent.
 *
 * A session observes on a cadence the user does not set, so entry count grows
 * with wall-clock time and nothing about a long session makes its earliest
 * minutes more worth reading than its last. Two hundred covers a session of
 * ordinary length whole, and truncates a runaway one at the end the
 * retrospective is about to reason over. `truncated` on the result says when
 * that happened, so a caller that wants the rest asks for it.
 */
export const DEFAULT_MAX_ENTRIES = 200;

/**
 * Entries whose AX tree renders in full, counted back from the most recent.
 *
 * The trees are the bulk of a timeline by an order of magnitude and the part
 * that ages worst: an old tree describes a screen that has since changed,
 * while the diff recorded next to it still says what moved. Rendering the
 * latest few in full and collapsing the rest keeps a long session inside a
 * sane prompt without losing when anything happened or what changed.
 */
export const DEFAULT_MAX_AX_TREES = 2;

/**
 * Bytes of rendered timeline text the retrospective reads by default.
 *
 * The count bounds above cap how many entries render, not how large they are,
 * and every retained string is emitted verbatim. A single AX tree runs to the
 * macOS enumerator's ceiling of 10,000 elements
 * (`AccessibilityTree.swift`), and diffs and narrations carry no length limit
 * of their own, so counting entries is not a bound on the prompt. This is.
 *
 * 120 KB is roughly 30k tokens of dense UI text, about a seventh of a
 * 200k-token window: enough for a long session's shape to survive intact,
 * while leaving the retrospective room for the conversation it is summarizing
 * and for its own reply. Callers that want more pass `maxRenderBytes`.
 */
export const DEFAULT_MAX_RENDER_BYTES = 120_000;

/**
 * The screen observation a timeline entry records, structurally the result the
 * host computer-use proxy already returns (`CU_RESULT_SCHEMA` in
 * `packages/electron-desktop/src/host-proxy/cu-executor.ts`). Declared here
 * over exactly those field names rather than invented: the observation reaches
 * this module straight off the wire, and a shape of our own would be a second
 * definition to keep in step with the first.
 */
export interface WatchObservationInput {
  readonly axTree?: string;
  readonly axDiff?: string;
  readonly screenshot?: string;
  readonly screenshotWidthPx?: number;
  readonly screenshotHeightPx?: number;
  readonly screenWidthPt?: number;
  readonly screenHeightPt?: number;
  readonly executionError?: string;
}

export type WatchEntryKind = "narration" | "observation";

/**
 * One persisted timeline row, without its screenshot. The frame is reachable
 * by id through {@link readWatchScreenshot}, so reading a session does not
 * hydrate its pixels.
 */
export interface WatchTimelineEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly atMs: number;
  readonly kind: WatchEntryKind;
  readonly text: string;
  readonly axTree: string | null;
  readonly axDiff: string | null;
  /** Size of the entry's screenshot, or null when it has none. */
  readonly screenshotBytes: number | null;
  readonly createdAt: number;
}

export type WatchAppendResult =
  | { ok: true; entryId: string }
  | {
      ok: false;
      reason:
        | "empty"
        | "observation_failed"
        | "conversation_missing"
        | "write_failed";
    };

export interface WatchTimelineRenderOptions {
  /** Entries to render, counted back from the most recent. */
  readonly maxEntries?: number;
  /** Entries whose AX tree renders in full, counted back from the most recent. */
  readonly maxAxTrees?: number;
  /** Bytes of rendered text to spend, newest entry first. */
  readonly maxRenderBytes?: number;
}

export interface WatchTimelineRender {
  /** The rendered timeline, one entry per block, oldest first. */
  readonly text: string;
  /** The entries `text` was rendered from, oldest first. */
  readonly entries: readonly WatchTimelineEntry[];
  /** Entries the session has, including any the bounds left out. */
  readonly totalEntries: number;
  /**
   * True when the render is partial: the count bound left earlier entries out,
   * the byte budget ran out before the oldest entry, or the budget cut an
   * entry's own content short.
   */
  readonly truncated: boolean;
  /**
   * Ids of the rendered entries that carry a screenshot, oldest first, ready
   * for {@link readWatchScreenshot}.
   */
  readonly screenshotEntryIds: readonly string[];
}

/**
 * Render `atMs` (milliseconds since the session started) as the `[t+MM:SS]`
 * prefix every entry carries. Hours appear only once there are any, so a
 * typical session reads as `[t+04:12]` rather than `[t+00:04:12]`.
 */
function formatOffset(atMs: number): string {
  const totalSeconds = Number.isFinite(atMs)
    ? Math.max(0, Math.floor(atMs / 1000))
    : 0;
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = pad(totalSeconds % 60);
  const minutes = pad(Math.floor(totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `[t+${pad(hours)}:${minutes}:${seconds}]`
    : `[t+${minutes}:${seconds}]`;
}

function normalizeAtMs(atMs: number): number {
  return Number.isFinite(atMs) ? Math.max(0, Math.floor(atMs)) : 0;
}

/**
 * Whether the conversation an entry is keyed to is still in the store.
 *
 * This is what keeps an append from outliving a delete. Every purge runs after
 * the conversation rows it covers are gone, so an append that starts once a
 * purge could no longer reach it finds nothing to key itself to and is
 * refused. The check is a read rather than a foreign key because a cascade
 * would delete on the store's terms rather than refuse on the append's, and a
 * cascade cannot refuse a row that arrives afterwards at all.
 */
function conversationStillExists(conversationId: string): boolean {
  return (
    getDb()
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get() !== undefined
  );
}

/** The row an append writes, screenshot included. */
type WatchTimelineRow = typeof watchTimelineEntries.$inferInsert;

/**
 * Persist one entry, refusing one a deletion has overtaken.
 *
 * The check and the insert are one synchronous step, so no purge can run
 * between them: the entry either predates the purge that covers it or is
 * turned away here.
 */
function insertEntry(row: WatchTimelineRow): WatchAppendResult {
  if (!conversationStillExists(row.conversationId)) {
    log.debug(
      { sessionId: row.sessionId, conversationId: row.conversationId },
      "Dropping a watch timeline entry for a conversation that is gone",
    );
    return { ok: false, reason: "conversation_missing" };
  }
  try {
    getDb().insert(watchTimelineEntries).values(row).run();
    return { ok: true, entryId: row.id };
  } catch (err) {
    log.warn(
      { err, sessionId: row.sessionId, kind: row.kind },
      "Failed to persist a watch timeline entry",
    );
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * Decode an observation's screenshot into the bytes the row carries, or null
 * when there is nothing worth storing.
 *
 * A session degrades to a timeline with fewer images rather than to no
 * timeline, so a frame that decodes to nothing or overruns
 * {@link MAX_SCREENSHOT_BYTES} logs and leaves the entry's screenshot null.
 */
function decodeScreenshot(
  sessionId: string,
  atMs: number,
  base64: string,
): Buffer | null {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    log.warn({ sessionId, atMs }, "Discarding an undecodable watch screenshot");
    return null;
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    log.warn(
      { sessionId, atMs, bytes: bytes.length },
      "Discarding a watch screenshot over the per-entry size cap",
    );
    return null;
  }
  return bytes;
}

/** Append what the user said at `atMs` milliseconds into the session. */
export function appendNarration(
  sessionId: string,
  options: { conversationId: string; text: string; atMs: number },
): WatchAppendResult {
  const text = options.text.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  return insertEntry({
    id: randomUUID(),
    sessionId,
    conversationId: options.conversationId,
    atMs: normalizeAtMs(options.atMs),
    kind: "narration",
    text,
    axTree: null,
    axDiff: null,
    screenshot: null,
    createdAt: Date.now(),
  });
}

/**
 * Append what was on screen at `atMs` milliseconds into the session.
 *
 * A failed or empty observation appends nothing: a row saying the screen could
 * not be read is a row the retrospective has to reason about, and the honest
 * timeline of a session where observation stalled is simply a sparser one.
 *
 * The screenshot is stored only when `attachScreenshot` asks for it, and
 * carrying one is not asking. The host captures a screenshot on every observe
 * with no opt-out, so an observation always has pixels available and a policy
 * of "store what arrives" is a policy of storing every frame. Which frames are
 * worth an image is a cadence decision, and it belongs to the caller driving
 * the session rather than to the row writer.
 *
 * A screenshot the caller asked to keep is content on its own, so an
 * observation carrying one is never empty. The host falls back to a bare
 * screenshot whenever accessibility enumeration yields no focused window
 * (`HostCuExecutor.swift`), which is the ordinary shape for an inaccessible
 * app: requiring a tree or a diff would make watching one produce an empty
 * timeline while the frames the user asked for were being discarded.
 */
export function appendObservation(
  sessionId: string,
  options: {
    conversationId: string;
    observation: WatchObservationInput;
    atMs: number;
    /** Store the observation's screenshot. Defaults to false. */
    attachScreenshot?: boolean;
  },
): WatchAppendResult {
  const { observation } = options;
  if (observation.executionError) {
    log.debug(
      { sessionId, executionError: observation.executionError },
      "Skipping a failed watch observation",
    );
    return { ok: false, reason: "observation_failed" };
  }
  const captured =
    options.attachScreenshot === true ? observation.screenshot : undefined;
  if (!observation.axTree && !observation.axDiff && !captured) {
    return { ok: false, reason: "empty" };
  }

  const atMs = normalizeAtMs(options.atMs);
  const screenshot = captured
    ? decodeScreenshot(sessionId, atMs, captured)
    : null;

  // A screenshot-only observation whose frame was discarded carries nothing at
  // all, so it falls back to the empty case rather than persisting a blank row.
  if (!observation.axTree && !observation.axDiff && !screenshot) {
    return { ok: false, reason: "empty" };
  }

  return insertEntry({
    id: randomUUID(),
    sessionId,
    conversationId: options.conversationId,
    atMs,
    kind: "observation",
    text: "",
    axTree: observation.axTree ?? null,
    axDiff: observation.axDiff ?? null,
    screenshot,
    createdAt: Date.now(),
  });
}

/**
 * Read one entry's screenshot, or null when it has none.
 *
 * Frames are fetched one at a time because a render's worth of them is the
 * only part of a timeline large enough to matter in memory, and a caller
 * attaching images knows which moments it wants.
 */
export function readWatchScreenshot(
  entryId: string,
): { mimeType: string; bytes: Buffer } | null {
  const row = getDb()
    .select({ screenshot: watchTimelineEntries.screenshot })
    .from(watchTimelineEntries)
    .where(eq(watchTimelineEntries.id, entryId))
    .get();
  if (!row?.screenshot) {
    return null;
  }
  return { mimeType: WATCH_SCREENSHOT_MIME, bytes: row.screenshot };
}

/** How many entries the session has, including any a read leaves out. */
function countEntries(sessionId: string): number {
  return (
    getDb()
      .select({ total: count() })
      .from(watchTimelineEntries)
      .where(eq(watchTimelineEntries.sessionId, sessionId))
      .get()?.total ?? 0
  );
}

/**
 * Read the newest `limit` entries of a session, oldest first.
 *
 * The bound is the SQL `LIMIT`, not a slice of the result: every row carries an
 * AX tree that runs to the macOS enumerator's ceiling, so a session-wide select
 * hydrates the whole session into memory before any render bound has a say. The
 * descending order is the exact inverse of the ascending one the rows are
 * rendered in, so taking the newest `limit` and reversing them gives the same
 * tail an ordered read would end with.
 *
 * The screenshot column is measured rather than selected, so the render learns
 * which entries have a frame and how large it is without pulling the pixels.
 */
function readNewestEntries(
  sessionId: string,
  limit: number,
): WatchTimelineEntry[] {
  if (limit <= 0) {
    return [];
  }
  const rows = getDb()
    .select({
      id: watchTimelineEntries.id,
      sessionId: watchTimelineEntries.sessionId,
      conversationId: watchTimelineEntries.conversationId,
      atMs: watchTimelineEntries.atMs,
      kind: watchTimelineEntries.kind,
      text: watchTimelineEntries.text,
      axTree: watchTimelineEntries.axTree,
      axDiff: watchTimelineEntries.axDiff,
      screenshotBytes: sql<
        number | null
      >`length(${watchTimelineEntries.screenshot})`,
      createdAt: watchTimelineEntries.createdAt,
    })
    .from(watchTimelineEntries)
    .where(eq(watchTimelineEntries.sessionId, sessionId))
    .orderBy(
      desc(watchTimelineEntries.atMs),
      desc(watchTimelineEntries.createdAt),
      desc(watchTimelineEntries.id),
    )
    .limit(limit)
    .all()
    .map((row) => ({ ...row, kind: row.kind as WatchEntryKind }));
  rows.reverse();
  return rows;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Clip `value` to `maxBytes` of UTF-8 and mark the cut.
 *
 * Slicing by bytes can land inside a multi-byte character, so the replacement
 * character the decode leaves at the tail is dropped.
 */
function clip(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }
  const keep = Math.max(0, maxBytes - TRUNCATION_MARKER.length - 1);
  const head = Buffer.from(value, "utf8")
    .subarray(0, keep)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return { text: `${head}\n${TRUNCATION_MARKER}`, truncated: true };
}

/** One entry rendered into the budget it was given. */
interface RenderedBlock {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Render one entry into at most `maxBytes`, with `renderAxTree` deciding
 * whether its tree is spelled out.
 *
 * The offset prefix, the diff, and the notes are paid for before the tree. The
 * tree is the bulk of an entry and the part that ages worst, so an entry the
 * budget squeezes keeps when it happened and what moved and gives up the full
 * screen. A screen the host captured but could not enumerate says so, so the
 * retrospective can tell "nothing was on screen" from "the screen was not
 * readable" and reach for the image instead.
 */
function renderEntry(
  entry: WatchTimelineEntry,
  renderAxTree: boolean,
  maxBytes: number,
): RenderedBlock {
  const offset = formatOffset(entry.atMs);
  if (entry.kind === "narration") {
    const head = `${offset} ${NARRATION_LABEL} `;
    const body = clip(entry.text, Math.max(0, maxBytes - byteLength(head)));
    return { text: `${head}${body.text}`, truncated: body.truncated };
  }

  const header = `${offset} ${OBSERVATION_LABEL}`;
  const notes: string[] = [];
  if (!entry.axTree && !entry.axDiff) {
    notes.push(AX_TREE_UNAVAILABLE);
  }
  if (entry.screenshotBytes !== null) {
    notes.push(SCREENSHOT_NOTE);
  }

  let remaining = maxBytes - byteLength(header);
  for (const note of notes) {
    remaining -= byteLength(note) + 1;
  }

  let truncated = false;

  let diffBlock: string | null = null;
  if (entry.axDiff) {
    const prefix = "changed since the previous observation:\n";
    const body = clip(
      entry.axDiff,
      Math.max(0, remaining - byteLength(prefix) - 1),
    );
    diffBlock = `${prefix}${body.text}`;
    truncated = truncated || body.truncated;
    remaining -= byteLength(diffBlock) + 1;
  }

  let treeBlock: string | null = null;
  if (entry.axTree) {
    const open = "<ax-tree>\n";
    const close = "\n</ax-tree>";
    const room = remaining - byteLength(open) - byteLength(close) - 1;
    if (!renderAxTree || room < MIN_AX_TREE_BYTES) {
      treeBlock = AX_TREE_OMITTED;
      // The count bound collapsing a tree is the documented default; the
      // budget collapsing one is a loss the caller has to hear about.
      truncated = truncated || renderAxTree;
    } else {
      const body = clip(escapeAxTreeContent(entry.axTree), room);
      treeBlock = `${open}${body.text}${close}`;
      truncated = truncated || body.truncated;
    }
  }

  const parts = [header];
  if (treeBlock !== null) {
    parts.push(treeBlock);
  }
  if (diffBlock !== null) {
    parts.push(diffBlock);
  }
  parts.push(...notes);
  return { text: parts.join("\n"), truncated };
}

/**
 * Render a session's timeline for the retrospective.
 *
 * Two bounds apply. The count bounds pick which entries are candidates and
 * which of their trees are spelled out; the byte budget then decides how much
 * of that actually fits, because a count is no bound at all on text that is
 * emitted verbatim. The budget is spent newest entry first, so the material
 * closest to the moment the retrospective is about is the material that
 * survives, and an entry too large for what is left is clipped with a marker
 * rather than dropped without one.
 *
 * The AX tree comes before the diff in an observation deliberately: the tree
 * is what the bounds collapse, so putting it first leaves the offset prefix
 * and the diff intact in an entry whose tree was left out.
 *
 * The result carries what the retrospective needs to decide how much of this
 * to use: how many entries the session actually has, whether anything was cut,
 * and the ids of the rendered entries that have a screenshot, so it can fetch
 * the images it wants and no others.
 */
export function renderWatchTimeline(
  sessionId: string,
  options?: WatchTimelineRenderOptions,
): WatchTimelineRender {
  const maxEntries = Math.max(0, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxAxTrees = Math.max(0, options?.maxAxTrees ?? DEFAULT_MAX_AX_TREES);
  const maxRenderBytes = Math.max(
    0,
    options?.maxRenderBytes ?? DEFAULT_MAX_RENDER_BYTES,
  );

  const totalEntries = countEntries(sessionId);
  const candidates = readNewestEntries(sessionId, maxEntries);

  const treeIndices = candidates
    .map((entry, index) => (entry.axTree ? index : -1))
    .filter((index) => index >= 0);
  const fullTreeFrom = treeIndices.length - maxAxTrees;
  const renderFullTree = new Set(treeIndices.slice(Math.max(0, fullTreeFrom)));

  const blocks: string[] = [];
  const entries: WatchTimelineEntry[] = [];
  let remaining = maxRenderBytes;
  let clipped = false;

  for (let index = candidates.length - 1; index >= 0; index--) {
    const entry = candidates[index];
    if (!entry) {
      continue;
    }
    const separator = blocks.length > 0 ? byteLength(BLOCK_SEPARATOR) : 0;
    const available = remaining - separator;
    if (available < MIN_ENTRY_BYTES) {
      clipped = true;
      break;
    }
    const block = renderEntry(entry, renderFullTree.has(index), available);
    blocks.push(block.text);
    entries.push(entry);
    remaining -= separator + byteLength(block.text);
    clipped = clipped || block.truncated;
  }

  blocks.reverse();
  entries.reverse();

  return {
    text: blocks.join(BLOCK_SEPARATOR),
    entries,
    totalEntries,
    truncated: clipped || entries.length < totalEntries,
    screenshotEntryIds: entries
      .filter((entry) => entry.screenshotBytes !== null)
      .map((entry) => entry.id),
  };
}

/**
 * Delete the timeline entries matching `where` and return how many went.
 *
 * One statement takes the narration, the screen, and the pixels together, and
 * `RETURNING` counts them without a second pass. It runs in process and
 * synchronously, which is what makes it uninterruptible: no append can slip
 * between the rows this statement matches and the rows it removes.
 */
function purgeEntries(where: SQL | undefined): number {
  return getDb()
    .delete(watchTimelineEntries)
    .where(where)
    .returning({ id: watchTimelineEntries.id })
    .all().length;
}

/**
 * Delete every timeline entry belonging to a conversation and return how many
 * went. Every conversation-delete path calls this: the entries hold frames of
 * the user's screen, so a delete that left them behind would strand the
 * conversation's most sensitive artifact in the database.
 *
 * Call it after the `conversations` row is gone. An append that arrives later
 * has nothing to key itself to and is refused, so the purge is the last thing
 * that has to reach a timeline row rather than one step among several.
 */
export function purgeWatchTimelineForConversation(
  conversationId: string,
): number {
  return purgeEntries(eq(watchTimelineEntries.conversationId, conversationId));
}

/**
 * Delete every timeline entry in the store and return how many went. The
 * clear-all wipe's counterpart to
 * {@link purgeWatchTimelineForConversation}, with the same ordering
 * requirement: it runs after `conversations` is emptied, so an append racing
 * the wipe either lands before this statement and is swept by it or arrives
 * afterwards and is refused.
 */
export function purgeAllWatchTimelines(): number {
  return purgeEntries(undefined);
}

/**
 * Entries one sweep pass removes.
 *
 * A session runs to hundreds of entries, so a pass covers several whole
 * sessions of residue while the statements it issues stay bounded rather than
 * scaling with however large a backlog grew. Anything past the bound is left
 * for the next pass.
 */
const MAX_SWEEP_ENTRIES = 5_000;

/**
 * Delete timeline entries whose conversation is no longer in the store and
 * return how many went.
 *
 * This is the recovery path for a purge that did not happen.
 * {@link purgeWatchTimelineForConversation} runs after the `conversations` row
 * is already committed as deleted, so its caller reports a completed delete
 * even when the purge fails, and a crash between those two writes leaves the
 * same residue. Nothing cascades into this table, so without a sweep either
 * case keeps narration, AX trees, and screenshots of the user for as long as
 * the database lives.
 *
 * Two bounded statements rather than one anti-join `DELETE`: a `LIMIT`ed select
 * picks a page of orphan ids, then the delete matches them by primary key.
 * Conversation ids are never reused, so a row the select called an orphan is
 * still one by the time the delete runs.
 *
 * Best-effort and idempotent. It runs from daemon startup and from database
 * maintenance, neither of which has anything useful to do with a failure, so a
 * failing statement logs and reports nothing swept and the next pass tries
 * again; a second run over swept rows finds none.
 */
export function sweepOrphanedWatchTimelineEntries(): number {
  try {
    const db = getDb();
    const orphanIds = db
      .select({ id: watchTimelineEntries.id })
      .from(watchTimelineEntries)
      .where(
        notExists(
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, watchTimelineEntries.conversationId)),
        ),
      )
      .limit(MAX_SWEEP_ENTRIES)
      .all()
      .map((row) => row.id);
    if (orphanIds.length === 0) {
      return 0;
    }
    return purgeEntries(inArray(watchTimelineEntries.id, orphanIds));
  } catch (err) {
    log.warn({ err }, "Failed to sweep orphaned watch timeline entries");
    return 0;
  }
}

/**
 * How many pages one drain will take before it stops.
 *
 * A ceiling on the work a single drain can do, not on the backlog it expects:
 * at {@link MAX_SWEEP_ENTRIES} a page this covers half a million rows, far past
 * any plausible residue. It exists so a page that reports rows swept without
 * shrinking the orphan set cannot spin, and whatever a capped drain leaves is
 * picked up by the next one.
 */
const MAX_SWEEP_PASSES = 100;

/**
 * Sweep until a pass comes back short, and return everything it removed.
 *
 * {@link sweepOrphanedWatchTimelineEntries} is deliberately one page, which is
 * what the periodic maintenance pass wants: bounded work on a tick that has
 * other things to do. Startup wants the opposite. It runs once, and on an
 * install where database maintenance never runs (it is driven by the memory
 * plugin's jobs worker, so a disabled plugin or `memory.enabled: false` stops
 * it), a single page is the only sweep the residue will ever see. A backlog
 * larger than one page would then keep narration, AX trees, and screenshots of
 * the user for the life of the database, which is the outcome the sweep exists
 * to prevent.
 *
 * A short page means the orphan set is exhausted, so the drain stops there
 * rather than paying for a pass that finds nothing. A failing page reports zero
 * and ends the drain; the next startup tries again.
 *
 * Async only to yield between pages. A page is a synchronous select and a
 * synchronous delete of rows carrying image blobs, and the caller runs at
 * startup with the HTTP server already bound, so a multi-page drain that never
 * came up for air would hold the event loop through every one of them and stall
 * requests the server has begun accepting. Yielding costs a macrotask per page
 * and gives that time back.
 */
export async function drainOrphanedWatchTimelineEntries(): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass += 1) {
    const swept = sweepOrphanedWatchTimelineEntries();
    total += swept;
    if (swept < MAX_SWEEP_ENTRIES) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return total;
}
