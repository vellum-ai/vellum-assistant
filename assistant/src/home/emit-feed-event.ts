/**
 * Background-job → home feed event helper.
 *
 * The "force-write, not taught-write" entry point for the activity
 * log. Every background job that wants to surface something on the
 * Home page calls `emitFeedEvent({ source, title, summary, ... })`
 * at the end of its completion path — no LLM involved, no prompt
 * instruction, just a deterministic side effect. This keeps the
 * "what got surfaced" question grep-able to a single symbol.
 *
 * Opinionated defaults for action items:
 *
 *   - `type` is hard-coded to `"action"` — this helper is specifically
 *     for the activity log. Nudges / digests / threads continue to
 *     go through `writeAssistantFeedItem` or platform baseline
 *     generators.
 *   - `author` is hard-coded to `"assistant"` so hybrid authoring
 *     resolution treats these as assistant-produced (platform
 *     defaults can never overwrite them).
 *   - `source` is REQUIRED — actions always have an origin (gmail,
 *     slack, calendar, assistant). The per-source volume cap in
 *     `feed-writer.ts` depends on this.
 *   - No default `expiresAt`. Action items persist until the user
 *     dismisses them. Callers that want auto-expiry pass `expiresAt`
 *     explicitly.
 *   - Optional `dedupKey` — when set, the helper derives a
 *     deterministic id so a second emit for the same logical event
 *     (e.g. the same background job running twice on the same
 *     signal) updates the existing entry in place instead of
 *     appending a duplicate. When absent, a fresh `randomUUID` is
 *     used and every call produces a new entry.
 *
 * Persistence goes through `appendFeedItem`, inheriting its
 * warn-log-on-failure contract — callers never need a try/catch.
 * Schema validation runs at build time so a malformed call throws
 * loudly at the source rather than silently corrupting the file.
 */

import { randomUUID } from "node:crypto";

import {
  type FeedAction,
  type FeedItem,
  feedItemSchema,
  type FeedItemSource,
} from "./feed-types.js";
import { appendFeedItem } from "./feed-writer.js";

/**
 * Default priority for background-job action items. Sits below the
 * assistant nudge default (60) so an explicit nudge from
 * `writeAssistantFeedItem` surfaces above routine activity log
 * entries, but above the platform baseline (40) so background job
 * traces outrank same-source platform defaults.
 */
const DEFAULT_EMIT_PRIORITY = 50;

/**
 * Parameters accepted by {@link emitFeedEvent}.
 *
 * All action items emitted by background jobs have an origin, so
 * `source` is required. Everything else is optional — callers supply
 * only the fields that describe the specific event.
 */
export interface EmitFeedEventParams {
  /** Origin of the underlying event (gmail, slack, calendar, assistant). */
  source: FeedItemSource;
  /** Short headline rendered in the feed row. */
  title: string;
  /** Body copy rendered below the title. */
  summary: string;
  /**
   * Stable key used to derive a deterministic id so a second emit
   * for the same logical event updates the existing feed entry in
   * place. Should include enough structure to identify the event
   * uniquely (e.g. `"gmail-unread:msg-<messageId>"`,
   * `"task-runner:<taskId>"`). When omitted, every call produces a
   * fresh id and appends a new entry.
   */
  dedupKey?: string;
  /**
   * Priority in [0, 100]. Defaults to {@link DEFAULT_EMIT_PRIORITY}
   * (50) — above the platform baseline of 40, below the assistant
   * nudge default of 60.
   */
  priority?: number;
  /** Action buttons surfaced on the feed row. */
  actions?: FeedAction[];
  /** Minimum seconds the user must be away before the item is shown. */
  minTimeAway?: number;
  /**
   * Absolute ISO-8601 expiry timestamp. Omit to let the item persist
   * until the user dismisses it (default for activity-log actions).
   */
  expiresAt?: string;
}

/**
 * Build a deterministic feed item id from a source + dedup key.
 *
 * The id is intentionally human-readable: `emit:<source>:<dedupKey>`.
 * This makes debugging easier than a hash (you can eyeball the file
 * and immediately see which background job produced which entry)
 * and `FeedItem.id` is a free-form string so there is no length or
 * charset constraint to worry about.
 */
function deterministicId(source: FeedItemSource, dedupKey: string): string {
  return `emit:${source}:${dedupKey}`;
}

/**
 * Emit a background-job activity-log entry onto the home feed.
 *
 * Builds a fully-formed assistant-authored `action` {@link FeedItem},
 * validates it against the canonical schema, and persists it via
 * {@link appendFeedItem}. Returns the constructed item so the caller
 * can log / reference it downstream.
 *
 * Throws a `ZodError` if the constructed item fails validation
 * (e.g. a `priority` outside `[0, 100]`) — a programming error in
 * the caller that must not be silently swallowed. Persistence-layer
 * failures are absorbed by `appendFeedItem` per its warn-log
 * contract.
 */
export async function emitFeedEvent(
  params: EmitFeedEventParams,
): Promise<FeedItem> {
  const now = new Date().toISOString();

  const id =
    params.dedupKey !== undefined
      ? deterministicId(params.source, params.dedupKey)
      : randomUUID();

  const item: FeedItem = {
    id,
    type: "action",
    source: params.source,
    title: params.title,
    summary: params.summary,
    priority: params.priority ?? DEFAULT_EMIT_PRIORITY,
    status: "new",
    author: "assistant",
    timestamp: now,
    createdAt: now,
    actions: params.actions,
    minTimeAway: params.minTimeAway,
    expiresAt: params.expiresAt,
  };

  // Programming-error guardrail: invalid input throws at the source
  // instead of corrupting the on-disk snapshot via the writer.
  feedItemSchema.parse(item);

  await appendFeedItem(item);

  return item;
}
