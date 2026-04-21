/**
 * Assistant-authoring helper for the home activity feed.
 *
 * This is the in-process API the assistant daemon (or a skill / tool
 * running inside it) calls to append a nudge, digest, action, or
 * thread to the macOS Home page feed under `author: "assistant"`.
 *
 * The helper exists so callers don't have to hand-roll the ceremony
 * around a `FeedItem`:
 *
 *   - generate a stable `id`
 *   - set the `author` discriminator to `"assistant"` (so the hybrid
 *     authoring resolver in `feed-writer.ts` lets it override
 *     platform baseline items for the same `(type, source)` pair)
 *   - seed `status` / `timestamp` / `createdAt`
 *   - pick a sensible default `priority` that outranks the platform
 *     baseline (40) so assistant-authored items surface above
 *     background generators unless an explicit priority is passed
 *   - validate the constructed item against `feedItemSchema` so a
 *     malformed call throws loudly at the source instead of corrupting
 *     the on-disk snapshot via `appendFeedItem`
 *
 * Persistence is delegated to `appendFeedItem` — all of the merge
 * semantics (digest replacement, thread in-place update, nudge author
 * precedence, action append-without-replace, per-source action cap)
 * continue to live in the writer and are not re-implemented here.
 *
 * NOTE: This helper is intentionally in-process only. There is no
 * HTTP route wrapping it. Callers (skills, tools, daemon code) import
 * and call `writeAssistantFeedItem` directly. Wiring the trigger side
 * — prompt-driven calls, skill entry points, etc. — is deliberately
 * out of scope for Phase 5 of the home-activity-feed plan and lives
 * in follow-up work.
 */

import { randomUUID } from "node:crypto";

import {
  type FeedAction,
  type FeedItem,
  feedItemSchema,
  type FeedItemSource,
  type FeedItemType,
  type FeedItemUrgency,
} from "./feed-types.js";
import { appendFeedItem } from "./feed-writer.js";

/**
 * Default priority for assistant-authored feed items. Sits above the
 * platform baseline (40) so an assistant-authored digest / nudge
 * surfaces above a same-source platform default unless the caller
 * passes an explicit value.
 */
const DEFAULT_ASSISTANT_PRIORITY = 60;

/**
 * Parameters accepted by {@link writeAssistantFeedItem}.
 *
 * The helper hard-codes `author: "assistant"`, `status: "new"`, and
 * the id / timestamps, so callers only have to supply the semantic
 * fields that describe *what* the item is about.
 */
export interface WriteAssistantFeedItemParams {
  /** Kind of feed item — drives the Swift view used to render it. */
  type: FeedItemType;
  /** Origin of the underlying event (gmail, slack, calendar, assistant). */
  source?: FeedItemSource;
  /** Short headline rendered in the feed row. */
  title: string;
  /** Body copy rendered below the title. */
  summary: string;
  /**
   * Priority in [0, 100]. Defaults to {@link DEFAULT_ASSISTANT_PRIORITY}
   * (60) — higher than the platform baseline of 40 so assistant items
   * beat same-source platform defaults by default.
   */
  priority?: number;
  /** Action buttons surfaced on the feed row. */
  actions?: FeedAction[];
  /** Minimum seconds the user must be away before the item is shown. */
  minTimeAway?: number;
  /** Absolute ISO-8601 expiry timestamp. */
  expiresAt?: string;
  /** Visual urgency treatment — controls badge color independently of sort priority. */
  urgency?: FeedItemUrgency;
}

/**
 * Build a fully-formed assistant-authored {@link FeedItem}, validate
 * it against the canonical schema, persist it through
 * {@link appendFeedItem}, and return the constructed item so the
 * caller can log / reference it downstream.
 *
 * Throws a `ZodError` if the constructed item fails validation —
 * that is a programming error in the caller (e.g. empty `title`) and
 * must not be silently swallowed. Persistence-layer failures are
 * absorbed by `appendFeedItem` itself per its warn-log contract.
 */
export async function writeAssistantFeedItem(
  params: WriteAssistantFeedItemParams,
): Promise<FeedItem> {
  const now = new Date().toISOString();

  const item: FeedItem = {
    id: randomUUID(),
    type: params.type,
    source: params.source,
    title: params.title,
    summary: params.summary,
    priority: params.priority ?? DEFAULT_ASSISTANT_PRIORITY,
    status: "new",
    author: "assistant",
    timestamp: now,
    createdAt: now,
    actions: params.actions,
    urgency: params.urgency,
    minTimeAway: params.minTimeAway,
    expiresAt: params.expiresAt,
  };

  // Programming-error guardrail: invalid input throws at the source
  // instead of corrupting the on-disk snapshot via the writer.
  feedItemSchema.parse(item);

  await appendFeedItem(item);

  return item;
}
