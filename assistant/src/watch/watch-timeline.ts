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

import { eq } from "drizzle-orm";

import { escapeAxTreeContent } from "../context/outbound-sanitize.js";
import {
  deleteAttachment,
  uploadAttachmentFromBytes,
} from "../persistence/attachments-store.js";
import { getDb } from "../persistence/db-connection.js";
import { watchTimelineEntries } from "../persistence/schema/watch.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("watch-timeline");

const NARRATION_LABEL = "narration:";
const OBSERVATION_LABEL = "screen:";

const SCREENSHOT_MIME = "image/jpeg";

/** Stands in for an AX tree the render bound left out. */
const AX_TREE_OMITTED = "<ax-tree-omitted />";

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
  | { ok: false; reason: "empty" | "observation_failed" | "write_failed" };

export interface WatchTimelineRenderOptions {
  /** Entries to render, counted back from the most recent. */
  readonly maxEntries?: number;
  /** Entries whose AX tree renders in full, counted back from the most recent. */
  readonly maxAxTrees?: number;
}

export interface WatchTimelineRender {
  /** The rendered timeline, one entry per block, oldest first. */
  readonly text: string;
  /** The entries `text` was rendered from, oldest first. */
  readonly entries: readonly WatchTimelineEntry[];
  /** Entries the session has, including any the bound left out. */
  readonly totalEntries: number;
  /** True when the bound left earlier entries out. */
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

function insertEntry(entry: WatchTimelineEntry): WatchAppendResult {
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
    screenshotAttachmentId: null,
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
  const { observation } = options;
  if (observation.executionError) {
    log.debug(
      { sessionId, executionError: observation.executionError },
      "Skipping a failed watch observation",
    );
    return { ok: false, reason: "observation_failed" };
  }
  if (!observation.axTree && !observation.axDiff) {
    return { ok: false, reason: "empty" };
  }

  const atMs = normalizeAtMs(options.atMs);
  const screenshotAttachmentId =
    options.attachScreenshot === true && observation.screenshot
      ? await storeScreenshot(sessionId, atMs, observation.screenshot)
      : null;

  const result = insertEntry({
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
  });

  if (!result.ok && screenshotAttachmentId) {
    deleteAttachment(screenshotAttachmentId);
  }
  return result;
}

/** Read a session's entries, oldest first. */
function readEntries(sessionId: string): WatchTimelineEntry[] {
  return getDb()
    .select()
    .from(watchTimelineEntries)
    .where(eq(watchTimelineEntries.sessionId, sessionId))
    .orderBy(
      watchTimelineEntries.atMs,
      watchTimelineEntries.createdAt,
      watchTimelineEntries.id,
    )
    .all()
    .map(toEntry);
}

/** Render one entry, with `renderAxTree` deciding whether its tree is spelled out. */
function renderEntry(entry: WatchTimelineEntry, renderAxTree: boolean): string {
  const offset = formatOffset(entry.atMs);
  if (entry.kind === "narration") {
    return `${offset} ${NARRATION_LABEL} ${entry.text}`;
  }

  const parts = [`${offset} ${OBSERVATION_LABEL}`];
  if (entry.axTree) {
    parts.push(
      renderAxTree
        ? `<ax-tree>\n${escapeAxTreeContent(entry.axTree)}\n</ax-tree>`
        : AX_TREE_OMITTED,
    );
  }
  if (entry.axDiff) {
    parts.push(`changed since the previous observation:\n${entry.axDiff}`);
  }
  if (entry.screenshotAttachmentId) {
    parts.push("a screenshot of this moment was captured.");
  }
  return parts.join("\n");
}

/**
 * Render a session's timeline for the retrospective.
 *
 * The AX tree comes before the diff in an observation deliberately: the tree
 * is what the bound collapses, so putting it first leaves the offset prefix
 * and the diff intact in an entry whose tree was left out.
 *
 * The result carries what the retrospective needs to decide how much of this
 * to use: how many entries the session actually has, whether the bound cut any
 * off, and the attachment ids of the screenshots among the entries rendered,
 * so it can attach the images it wants without a second query.
 */
export function renderWatchTimeline(
  sessionId: string,
  options?: WatchTimelineRenderOptions,
): WatchTimelineRender {
  const maxEntries = Math.max(0, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxAxTrees = Math.max(0, options?.maxAxTrees ?? DEFAULT_MAX_AX_TREES);

  const all = readEntries(sessionId);
  const entries = all.slice(Math.max(0, all.length - maxEntries));

  const treeIndices = entries
    .map((entry, index) => (entry.axTree ? index : -1))
    .filter((index) => index >= 0);
  const fullTreeFrom = treeIndices.length - maxAxTrees;
  const renderFullTree = new Set(treeIndices.slice(Math.max(0, fullTreeFrom)));

  return {
    text: entries
      .map((entry, index) => renderEntry(entry, renderFullTree.has(index)))
      .join("\n\n"),
    entries,
    totalEntries: all.length,
    truncated: entries.length < all.length,
    screenshotAttachmentIds: entries
      .map((entry) => entry.screenshotAttachmentId)
      .filter((id): id is string => id !== null),
  };
}

/**
 * Delete every timeline entry belonging to a conversation, along with the
 * screenshots those entries own.
 *
 * Attachments go first. A row deleted before its attachment is a screenshot
 * nothing points at, which no later sweep can attribute to anything.
 */
export function purgeWatchTimelineForConversation(
  conversationId: string,
): WatchTimelinePurgeResult {
  const db = getDb();
  const rows = db
    .select({
      screenshotAttachmentId: watchTimelineEntries.screenshotAttachmentId,
    })
    .from(watchTimelineEntries)
    .where(eq(watchTimelineEntries.conversationId, conversationId))
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

  db.delete(watchTimelineEntries)
    .where(eq(watchTimelineEntries.conversationId, conversationId))
    .run();

  return { entriesDeleted: rows.length, attachmentsDeleted };
}
