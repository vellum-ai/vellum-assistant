/**
 * Home activity feed data contract.
 *
 * The feed-item and suggested-prompt wire shapes are owned by the
 * canonical `@vellumai/assistant-api` package (`api/responses/home.ts`)
 * so the daemon route handlers, the OpenAPI generator, and external
 * clients all derive from one source. This module re-exports those
 * shapes for daemon-internal consumers and adds the on-disk file format
 * (`HomeFeedFile`) that composes them — a daemon-only persistence
 * concern that never crosses the wire.
 *
 * The TDD contract field originally named `ttl` is surfaced as
 * `expiresAt` — an absolute ISO-8601 timestamp, not a duration. Absolute
 * timestamps match the `timestamp` and `createdAt` fields and make
 * stateless read-time expiry filtering trivial.
 *
 * **v2 schema collapse** — feed items now have a single `notification`
 * type. The legacy `nudge | digest | action | thread` distinctions
 * (and the `source` / `author` / `minTimeAway` fields that supported
 * them) have been removed; everything that lands in the home feed is
 * a notification, with the writer's only merge rule being "same `id`
 * replaces in place, otherwise append". Workspace migration
 * `079-home-feed-notification-only` rewrites pre-v2 files on first boot.
 */

import { z } from "zod";

import { FeedItemSchema } from "../api/responses/home.js";

export {
  type FeedAction,
  type FeedItem,
  type FeedItemCategory,
  type FeedItemDetailPanel,
  type FeedItemDetailPanelKind,
  FeedItemSchema as feedItemSchema,
  type FeedItemStatus,
  type FeedItemType,
  type FeedItemUrgency,
  type SuggestedPrompt,
  SuggestedPromptSchema as suggestedPromptSchema,
  type SuggestedPromptSource,
} from "../api/responses/home.js";

/**
 * On-disk file format for `$VELLUM_WORKSPACE_DIR/data/home-feed.json`.
 *
 * Written by the feed writer, read by the HTTP route and `parseFeedFile`
 * below. `version` is pinned to `2` (collapsed schema); pre-v2 files are
 * rewritten by workspace migration `079-home-feed-notification-only`.
 */
export interface HomeFeedFile {
  version: 2;
  items: z.infer<typeof FeedItemSchema>[];
  updatedAt: string;
}

/**
 * Envelope schema for the on-disk `home-feed.json` file. Items stay
 * unvalidated here so `parseFeedFile` can validate them one at a time.
 */
const homeFeedEnvelopeSchema = z.object({
  version: z.literal(2),
  items: z.array(z.unknown()),
  updatedAt: z.string(),
});

/**
 * Parse and validate a raw value read from `home-feed.json`.
 *
 * Used by the writer on read-back and by the HTTP route when serving the
 * feed. Throws a `ZodError` when the envelope itself is invalid (wrong
 * `version`, non-object input, missing `updatedAt`). Callers are
 * expected to log + recover (e.g. treat the file as empty). Individual
 * items that fail validation are dropped and counted in `droppedCount`,
 * an in-memory-only field on the return value that is never persisted,
 * so one malformed row cannot erase the rest of the feed.
 */
export function parseFeedFile(
  raw: unknown,
): HomeFeedFile & { droppedCount: number } {
  const envelope = homeFeedEnvelopeSchema.parse(raw);

  const items: z.infer<typeof FeedItemSchema>[] = [];
  let droppedCount = 0;
  for (const rawItem of envelope.items) {
    const result = FeedItemSchema.safeParse(rawItem);
    if (result.success) {
      items.push(result.data);
    } else {
      droppedCount++;
    }
  }

  return {
    version: envelope.version,
    items,
    updatedAt: envelope.updatedAt,
    droppedCount,
  };
}
