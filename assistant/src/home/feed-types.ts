/**
 * Home activity feed data contract.
 *
 * Defines the shape of `FeedItem`s shown in the macOS Home page feed
 * section (nudges, digests, actions, threads) plus the on-disk file
 * format written by the daemon feed writer (PR 5) and served by the
 * daemon HTTP route (PR 6).
 *
 * The TDD contract field originally named `ttl` is renamed internally
 * to `expiresAt` — it is an absolute ISO-8601 timestamp, not a
 * duration. Absolute timestamps match the `timestamp` and `createdAt`
 * fields and make stateless read-time expiry filtering trivial. If we
 * ever need to expose `ttl` on a public wire format again we can add
 * a translation layer at the route boundary; within the daemon, all
 * internal types use `expiresAt`.
 *
 * A structurally compatible Swift mirror lives at
 * `clients/shared/Network/FeedItem.swift` (PR 3). Any change here
 * must be mirrored there.
 */

import { z } from "zod";

/** High-level kind of feed item — drives which Swift view renders it. */
export type FeedItemType = "nudge" | "digest" | "action" | "thread";

/** User-facing lifecycle of a feed item. */
export type FeedItemStatus = "new" | "seen" | "acted_on";

/**
 * Origin of the underlying event.
 *
 * In v1 this is constrained to a closed set so the Swift icon mapping
 * stays exhaustive. Future sources will be added explicitly rather
 * than letting arbitrary strings slip through.
 */
export type FeedItemSource = "gmail" | "slack" | "calendar" | "assistant";

/**
 * Internal field used by the hybrid authoring resolver (PR 5 writer).
 *
 * Not part of the TDD public interface — it distinguishes items the
 * assistant produced on its own from items the platform baseline
 * generators (e.g. Gmail digest in PR 12) produced, so assistant
 * overrides can win over platform defaults for the same source.
 */
export type FeedItemAuthor = "assistant" | "platform";

/**
 * A single action button attached to a feed item.
 *
 * `prompt` is the pre-seeded user message the action sends to the
 * assistant when triggered — the HTTP route (PR 6) creates a new
 * conversation with this prompt as the first user turn.
 */
export interface FeedAction {
  id: string;
  label: string;
  prompt: string;
}

/**
 * A single item rendered in the Home feed.
 *
 * Mirrors the TDD contract plus two internal-only fields:
 *   - `author`  — hybrid-authoring resolver discriminator
 *   - `createdAt` — when the writer recorded the item (distinct from
 *                   `timestamp`, which is the event time). Used for
 *                   TTL sweeps and stable ordering.
 *
 * The TDD's `ttl` field is renamed to `expiresAt` here; see the
 * module comment above for the rationale.
 */
export interface FeedItem {
  id: string;
  type: FeedItemType;
  /** Integer in [0, 100]; higher values sort earlier. */
  priority: number;
  title: string;
  summary: string;
  /** Optional; when present must be one of the four v1 sources. */
  source?: FeedItemSource;
  /** Event time (ISO-8601). */
  timestamp: string;
  /** Defaults to `"new"` at parse time. */
  status: FeedItemStatus;
  /** Absolute ISO-8601 expiry timestamp (renamed from TDD `ttl`). */
  expiresAt?: string;
  /** Minimum seconds the user must be away before the item is shown. */
  minTimeAway?: number;
  actions?: FeedAction[];
  /** Internal: who authored this item. */
  author: FeedItemAuthor;
  /** Internal: ISO-8601 writer-record time, used for ordering + TTL. */
  createdAt: string;
}

/**
 * On-disk file format for `~/.vellum/workspace/data/home-feed.json`.
 *
 * Written by the PR 5 writer, read by the PR 6 HTTP route and
 * `parseFeedFile` below. `version` is pinned to `1`; future format
 * changes bump this and live behind a workspace migration.
 */
export interface HomeFeedFile {
  version: 1;
  items: FeedItem[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const feedItemTypeSchema = z.enum(["nudge", "digest", "action", "thread"]);

const feedItemStatusSchema = z.enum(["new", "seen", "acted_on"]);

const feedItemSourceSchema = z.enum([
  "gmail",
  "slack",
  "calendar",
  "assistant",
]);

const feedItemAuthorSchema = z.enum(["assistant", "platform"]);

const feedActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
});

/**
 * Schema for a single `FeedItem`.
 *
 * Notes:
 *   - `priority` must be an integer in [0, 100]; string numerics
 *     (e.g. `"5"`) are rejected — we want deterministic ordering and
 *     silent coercion tends to mask writer bugs.
 *   - `status` defaults to `"new"` so the writer does not need to
 *     set it on every append.
 *   - `source` is optional but, when present, must be one of the
 *     four v1 sources — unknown values (e.g. `"facebook"`) are
 *     rejected rather than silently passed through.
 *   - `minTimeAway` is a non-negative integer number of seconds.
 */
export const feedItemSchema = z.object({
  id: z.string(),
  type: feedItemTypeSchema,
  priority: z.number().int().min(0).max(100),
  title: z.string(),
  summary: z.string(),
  source: feedItemSourceSchema.optional(),
  timestamp: z.string(),
  status: feedItemStatusSchema.default("new"),
  expiresAt: z.string().optional(),
  minTimeAway: z.number().int().min(0).optional(),
  actions: z.array(feedActionSchema).optional(),
  author: feedItemAuthorSchema,
  createdAt: z.string(),
});

/** Schema for the on-disk `home-feed.json` file. */
export const homeFeedFileSchema = z.object({
  version: z.literal(1),
  items: z.array(feedItemSchema),
  updatedAt: z.string(),
});

/**
 * Parse and validate a raw value read from `home-feed.json`.
 *
 * Used by the PR 5 writer on read-back and by the PR 6 HTTP route
 * when serving the feed. Throws a `ZodError` on any validation
 * failure — callers are expected to log + recover (e.g. treat the
 * file as empty).
 */
export function parseFeedFile(raw: unknown): HomeFeedFile {
  return homeFeedFileSchema.parse(raw) as HomeFeedFile;
}
