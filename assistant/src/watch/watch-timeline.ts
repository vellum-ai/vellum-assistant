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
 * Screenshots go to the attachments store and the row keeps only the id. A
 * half-hour session's frames are tens of megabytes, which belong on disk
 * behind an id rather than base64 in a SQLite column.
 */

import { randomUUID } from "node:crypto";

import { count, desc, eq, type SQL } from "drizzle-orm";

import { escapeAxTreeContent } from "../context/outbound-sanitize.js";
import {
  deleteAttachment,
  uploadAttachmentFromBytes,
} from "../persistence/attachments-store.js";
import { getDb } from "../persistence/db-connection.js";
import { conversations } from "../persistence/schema/conversations.js";
import { watchTimelineEntries } from "../persistence/schema/watch.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("watch-timeline");

const NARRATION_LABEL = "narration:";
const OBSERVATION_LABEL = "screen:";

const SCREENSHOT_MIME = "image/jpeg";

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

/** One persisted timeline row. */
export interface WatchTimelineEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly atMs: number;
  readonly kind: WatchEntryKind;
  readonly text: string;
  readonly axTree: string | null;
  readonly axDiff: string | null;
  readonly screenshotAttachmentId: string | null;
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
        | "store_wiped"
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
  /** Attachment ids of the rendered entries' screenshots, oldest first. */
  readonly screenshotAttachmentIds: readonly string[];
}

export interface WatchTimelinePurgeResult {
  readonly entriesDeleted: number;
  readonly attachmentsDeleted: number;
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

function toEntry(row: typeof watchTimelineEntries.$inferSelect) {
  return {
    ...row,
    kind: row.kind as WatchEntryKind,
  } satisfies WatchTimelineEntry;
}

/**
 * Full wipes running in this process, and the epoch each one advances.
 *
 * A full wipe is a sequence of deletes rather than one statement, and an
 * append is not instantaneous either, so the two interleave in both
 * directions. {@link conversationStillExists} covers only the ordering where
 * the conversation row is already gone by the time the append writes; an
 * append reaching its insert while the wipe is still working through the
 * tables ahead of `conversations` passes that check and writes a row the wipe
 * has already swept past.
 *
 * The epoch covers the rest. An append captures it as it begins and refuses to
 * insert when a wipe is in flight or the epoch has moved since, so a row lands
 * only when no wipe overlapped the append at any point.
 */
let wipesInFlight = 0;
let wipeEpoch = 0;

/**
 * Run a full wipe with watch appends refused for its whole duration.
 *
 * The wrapper spans the wipe rather than the timeline purge alone: the purge
 * is one step partway through the sequence, and an append landing after it
 * still has a live `conversations` row to pass the existence check against.
 */
export async function withWatchTimelineWipe<T>(
  wipe: () => Promise<T>,
): Promise<T> {
  wipesInFlight += 1;
  wipeEpoch += 1;
  try {
    return await wipe();
  } finally {
    wipesInFlight -= 1;
  }
}

/** Whether an append that began at `epoch` is still clear of every wipe. */
function appendSurvivedWipes(epoch: number): boolean {
  return wipesInFlight === 0 && epoch === wipeEpoch;
}

/**
 * Whether the conversation an entry is keyed to is still in the store.
 *
 * The check is a read rather than a foreign key because the two would want
 * opposite things from a delete. `purgeEntries` reads each row's
 * `screenshotAttachmentId` and unlinks the staged frame before dropping the
 * row, and it runs after the conversation row is gone; a cascade would have
 * removed those rows first and left the frames on disk as files nothing points
 * at.
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

/**
 * Persist one entry, refusing an entry a deletion has overtaken.
 *
 * An append is not instantaneous: an observation stores its screenshot before
 * it writes its row, and a deletion landing inside that gap would leave a row
 * keyed to a conversation that no longer exists. Nothing could reach that row
 * afterwards, because every purge is scoped to a conversation or to the whole
 * store, so the entry and the frame it owns would survive the deletion
 * indefinitely. Both guards make the write the point where that is noticed:
 * `epochAtAppendStart` covers a full wipe, the existence check covers a
 * single-conversation delete.
 */
function insertEntry(
  entry: WatchTimelineEntry,
  epochAtAppendStart: number,
): WatchAppendResult {
  if (!appendSurvivedWipes(epochAtAppendStart)) {
    log.debug(
      { sessionId: entry.sessionId, conversationId: entry.conversationId },
      "Dropping a watch timeline entry that spans a full wipe",
    );
    return { ok: false, reason: "store_wiped" };
  }
  if (!conversationStillExists(entry.conversationId)) {
    log.debug(
      { sessionId: entry.sessionId, conversationId: entry.conversationId },
      "Dropping a watch timeline entry for a conversation that is gone",
    );
    return { ok: false, reason: "conversation_missing" };
  }
  try {
    getDb().insert(watchTimelineEntries).values(entry).run();
    return { ok: true, entryId: entry.id };
  } catch (err) {
    log.warn(
      { err, sessionId: entry.sessionId, kind: entry.kind },
      "Failed to persist a watch timeline entry",
    );
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * Store an observation's screenshot and return its attachment id, or null when
 * it could not be stored.
 *
 * A session degrades to a timeline with fewer images rather than to no
 * timeline, so a failed upload logs and leaves the entry's screenshot null.
 */
async function storeScreenshot(
  sessionId: string,
  atMs: number,
  base64: string,
): Promise<string | null> {
  try {
    const stored = await uploadAttachmentFromBytes(
      `watch-screen-${atMs}.jpg`,
      SCREENSHOT_MIME,
      Buffer.from(base64, "base64"),
    );
    return stored.id;
  } catch (err) {
    log.warn(
      { err, sessionId, atMs },
      "Failed to store a watch observation screenshot",
    );
    return null;
  }
}

/** Append what the user said at `atMs` milliseconds into the session. */
export function appendNarration(
  sessionId: string,
  options: { conversationId: string; text: string; atMs: number },
): WatchAppendResult {
  const epochAtAppendStart = wipeEpoch;
  const text = options.text.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  return insertEntry(
    {
      id: randomUUID(),
      sessionId,
      conversationId: options.conversationId,
      atMs: normalizeAtMs(options.atMs),
      kind: "narration",
      text,
      axTree: null,
      axDiff: null,
      screenshotAttachmentId: null,
      createdAt: Date.now(),
    },
    epochAtAppendStart,
  );
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
export async function appendObservation(
  sessionId: string,
  options: {
    conversationId: string;
    observation: WatchObservationInput;
    atMs: number;
    /** Store the observation's screenshot. Defaults to false. */
    attachScreenshot?: boolean;
  },
): Promise<WatchAppendResult> {
  const epochAtAppendStart = wipeEpoch;
  const { observation } = options;
  if (observation.executionError) {
    log.debug(
      { sessionId, executionError: observation.executionError },
      "Skipping a failed watch observation",
    );
    return { ok: false, reason: "observation_failed" };
  }
  const screenshot =
    options.attachScreenshot === true ? observation.screenshot : undefined;
  if (!observation.axTree && !observation.axDiff && !screenshot) {
    return { ok: false, reason: "empty" };
  }

  const atMs = normalizeAtMs(options.atMs);
  const screenshotAttachmentId = screenshot
    ? await storeScreenshot(sessionId, atMs, screenshot)
    : null;

  // A screenshot-only observation whose upload failed carries nothing at all,
  // so it falls back to the empty case rather than persisting a blank row.
  if (!observation.axTree && !observation.axDiff && !screenshotAttachmentId) {
    return { ok: false, reason: "empty" };
  }

  const result = insertEntry(
    {
      id: randomUUID(),
      sessionId,
      conversationId: options.conversationId,
      atMs,
      kind: "observation",
      text: "",
      axTree: observation.axTree ?? null,
      axDiff: observation.axDiff ?? null,
      screenshotAttachmentId,
      createdAt: Date.now(),
    },
    epochAtAppendStart,
  );

  // A row that did not land leaves its screenshot owned by nothing, so the
  // upload is undone rather than left staged on disk. The refusal runs in the
  // upload's own continuation, so the attachment row is always still there for
  // `deleteAttachment` to unlink the file through.
  if (!result.ok && screenshotAttachmentId) {
    deleteAttachment(screenshotAttachmentId);
  }
  return result;
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
 */
function readNewestEntries(
  sessionId: string,
  limit: number,
): WatchTimelineEntry[] {
  if (limit <= 0) {
    return [];
  }
  const rows = getDb()
    .select()
    .from(watchTimelineEntries)
    .where(eq(watchTimelineEntries.sessionId, sessionId))
    .orderBy(
      desc(watchTimelineEntries.atMs),
      desc(watchTimelineEntries.createdAt),
      desc(watchTimelineEntries.id),
    )
    .limit(limit)
    .all()
    .map(toEntry);
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
  if (entry.screenshotAttachmentId) {
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
 * and the attachment ids of the screenshots among the entries rendered, so it
 * can attach the images it wants without a second query.
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
    screenshotAttachmentIds: entries
      .map((entry) => entry.screenshotAttachmentId)
      .filter((id): id is string => id !== null),
  };
}

/**
 * Delete the timeline entries matching `where`, along with the screenshots
 * those entries own.
 *
 * Attachments go first. A row deleted before its attachment is a screenshot
 * nothing points at, which no later sweep can attribute to anything.
 * `deleteAttachment` unlinks the staged file with the row, so the frames leave
 * disk rather than surviving as unreferenced bytes under the workspace.
 */
function purgeEntries(where: SQL | undefined): WatchTimelinePurgeResult {
  const db = getDb();
  const rows = db
    .select({
      screenshotAttachmentId: watchTimelineEntries.screenshotAttachmentId,
    })
    .from(watchTimelineEntries)
    .where(where)
    .all();

  let attachmentsDeleted = 0;
  for (const row of rows) {
    if (!row.screenshotAttachmentId) {
      continue;
    }
    if (deleteAttachment(row.screenshotAttachmentId) === "deleted") {
      attachmentsDeleted += 1;
    }
  }

  db.delete(watchTimelineEntries).where(where).run();

  return { entriesDeleted: rows.length, attachmentsDeleted };
}

/**
 * Delete every timeline entry belonging to a conversation, along with the
 * screenshots those entries own. Every conversation-delete path calls this:
 * the entries hold frames of the user's screen, so a delete that left them
 * behind would strand the conversation's most sensitive artifact on disk.
 */
export function purgeWatchTimelineForConversation(
  conversationId: string,
): WatchTimelinePurgeResult {
  return purgeEntries(eq(watchTimelineEntries.conversationId, conversationId));
}

/**
 * Delete every timeline entry in the store, along with the screenshots those
 * entries own. The clear-all wipe's counterpart to
 * {@link purgeWatchTimelineForConversation}: a wipe that dropped the rows
 * alone would leave the frames behind as staged files no row points at.
 */
export function purgeAllWatchTimelines(): WatchTimelinePurgeResult {
  return purgeEntries(undefined);
}
