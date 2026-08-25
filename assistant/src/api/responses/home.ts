/**
 * Wire contract for the Home REST endpoints.
 *
 *   - `GET /v1/home/feed`   → `HomeFeedResponse`
 *   - `PATCH /v1/home/feed/:id` → `FeedItem`
 *   - `GET /v1/home/state`  → `RelationshipState`
 *
 * Holds the canonical feed-item, suggested-prompt, and relationship-state
 * shapes shared by the daemon route handlers, the on-disk feed-file parser
 * (`home/feed-types.ts`), and every external client. Defining them here —
 * rather than inline in the route files — means the daemon, the OpenAPI
 * generator, and the web/CLI clients all derive from one source and cannot
 * drift.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Feed item
// ---------------------------------------------------------------------------

/**
 * High-level kind of feed item: it drives which client view renders it.
 *
 * `notification` is a one-shot event. `run` is async work with a lifecycle,
 * rewritten in place as it progresses. `digest` folds a window of routine
 * finished work into one row. `system_health` is a durable counter for a
 * subsystem that keeps failing.
 *
 * Defaults to `notification` so rows written before the vocabulary widened
 * still parse.
 */
export const FeedItemTypeSchema = z
  .enum(["notification", "run", "digest", "system_health"])
  .default("notification");
export type FeedItemType = z.infer<typeof FeedItemTypeSchema>;

/**
 * Which section of the notification surfaces a row lands in, and how loudly
 * it arrives. Derived by fixed rules rather than chosen by the decision
 * engine, so placement is predictable: the model keeps channel selection and
 * wording and has no say in importance.
 *
 * - `needs_you`: work is blocked on the user. Toast plus banner, every time.
 * - `worth_knowing`: a real outcome or observation, nothing blocked. Toast
 *   in-app, banner when away, once.
 * - `activity`: routine work, running or finished. Silent.
 */
export const FeedItemBucketSchema = z.enum([
  "needs_you",
  "worth_knowing",
  "activity",
]);
export type FeedItemBucket = z.infer<typeof FeedItemBucketSchema>;

/**
 * Lifecycle of a run.
 *
 * `queued → running → succeeded | failed | cancelled | interrupted`, with
 * `needs_input` as a side state `running` can enter and leave.
 */
export const FeedItemRunStateSchema = z.enum([
  "queued",
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type FeedItemRunState = z.infer<typeof FeedItemRunStateSchema>;

/** Terminal run states: nothing is driving the run any more. */
export const TERMINAL_RUN_STATES: readonly FeedItemRunState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

export function isTerminalRunState(state: FeedItemRunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/**
 * Run payload on a `run` feed item.
 *
 * `parentRunId` links a run into a tree, so a chat turn that spawns three
 * subagents reports as one row with a child count rather than four rows.
 * `childTotal`/`childDone` are maintained on the root as children settle.
 */
export const FeedItemRunSchema = z.object({
  runId: z.string(),
  parentRunId: z.string().optional(),
  /** Producer-scoped kind, e.g. `subagent`, `skill_learning`, `scheduled_run`. */
  kind: z.string(),
  state: FeedItemRunStateSchema,
  /** ISO-8601 start time. Clients render elapsed time against it. */
  startedAt: z.string(),
  /** ISO-8601 end time. Present exactly when the state is terminal. */
  endedAt: z.string().optional(),
  /** Latest step the work reported, replaced on each update. */
  progressNote: z.string().optional(),
  /** Human-readable reason a run failed. Never a raw error constant. */
  failureReason: z.string().optional(),
  childTotal: z.number().int().nonnegative().optional(),
  childDone: z.number().int().nonnegative().optional(),
  /** Whether the client should offer Retry / Re-run on a terminal row. */
  retryable: z.boolean().optional(),
});
export type FeedItemRun = z.infer<typeof FeedItemRunSchema>;

/**
 * System-health payload: one durable counter row per failing subsystem,
 * replacing the per-failure notifications that used to repeat forever
 * because the dedupe window reset daily.
 */
export const FeedItemSystemHealthSchema = z.object({
  /** Stable subsystem id, e.g. `heartbeat`, `telegram_webhook`. */
  subsystem: z.string(),
  failureCount: z.number().int().positive(),
  firstFailureAt: z.string(),
  lastFailureAt: z.string(),
  /** Sanitized one-line description of the latest failure. */
  lastErrorSummary: z.string().optional(),
  /** Deep link the client offers as a repair affordance, when one exists. */
  remedyPath: z.string().optional(),
  remedyLabel: z.string().optional(),
});
export type FeedItemSystemHealth = z.infer<typeof FeedItemSystemHealthSchema>;

/** Digest payload: a window of routine finished runs folded into one row. */
export const FeedItemDigestSchema = z.object({
  runCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  windowStart: z.string(),
  windowEnd: z.string(),
});
export type FeedItemDigest = z.infer<typeof FeedItemDigestSchema>;

/** User-facing lifecycle of a feed item. */
export const FeedItemStatusSchema = z.enum([
  "new",
  "seen",
  "acted_on",
  "dismissed",
]);
export type FeedItemStatus = z.infer<typeof FeedItemStatusSchema>;

/** Visual urgency treatment — controls badge color independently of sort priority. */
export const FeedItemUrgencySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export type FeedItemUrgency = z.infer<typeof FeedItemUrgencySchema>;

/** Broad category for grouping and filtering feed items. */
export const FeedItemCategorySchema = z.enum([
  "security",
  "scheduling",
  "background",
  "email",
  "system",
]);
export type FeedItemCategory = z.infer<typeof FeedItemCategorySchema>;

/**
 * Producer of a feed item's source conversation — lets clients filter the
 * activity feed by what generated each notification: the periodic
 * heartbeat, a memory-consolidation pass, a recurring schedule, an
 * auto-analysis run, etc. Derived at read time from the source
 * conversation's `source` column (see `home/feed-source-enrichment.ts`).
 * Individual schedules are distinguished by `sourceKey`/`sourceLabel`, not
 * this coarse type.
 */
export const FeedItemSourceTypeSchema = z.enum([
  "heartbeat",
  "memory_consolidation",
  "schedule",
  "auto_analysis",
  "user",
  "other",
]);
export type FeedItemSourceType = z.infer<typeof FeedItemSourceTypeSchema>;

/**
 * A single action button attached to a feed item.
 *
 * `prompt` is the pre-seeded user message the action sends to the
 * assistant when triggered — the HTTP route creates a new conversation
 * with this prompt as the first user turn.
 */
export const FeedActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
});
export type FeedAction = z.infer<typeof FeedActionSchema>;

/** Which detail panel the client should open for this feed item. */
export const FeedItemDetailPanelKindSchema = z.enum([
  "emailDraft",
  "documentPreview",
  "permissionChat",
  "paymentAuth",
  "toolPermission",
  "updatesList",
]);
export type FeedItemDetailPanelKind = z.infer<
  typeof FeedItemDetailPanelKindSchema
>;

/** Server-driven detail panel descriptor attached to a feed item. */
export const FeedItemDetailPanelSchema = z.object({
  kind: FeedItemDetailPanelKindSchema,
});
export type FeedItemDetailPanel = z.infer<typeof FeedItemDetailPanelSchema>;

/**
 * A single item rendered in the Home feed.
 *
 * Notes:
 *   - `bucket` is the placement field: which of the three sections the row
 *     belongs to, and how loudly it arrives.
 *   - `priority`, `noteworthy`, and `category` are compat projections of
 *     `bucket`, written so clients built against the pre-bucket contract
 *     keep sorting and grouping sensibly. Nothing derives them
 *     independently any more, and new client code must read `bucket`.
 *   - `priority` must be an integer in [0, 100]; string numerics
 *     (e.g. `"5"`) are rejected — we want deterministic ordering and
 *     silent coercion tends to mask writer bugs.
 *   - `status` defaults to `"new"` so the writer does not need to set it
 *     on every append.
 *   - `createdAt` is the writer-record time (distinct from `timestamp`,
 *     the event time). Used for TTL sweeps and stable ordering.
 *   - `expiresAt` is an absolute ISO-8601 expiry timestamp.
 *   - `title` is optional — clients fall back to `summary` when a row has
 *     no header.
 *   - `run` / `systemHealth` / `digest` are present exactly when `type` is
 *     the matching row kind.
 */
export const FeedItemSchema = z.object({
  id: z.string(),
  type: FeedItemTypeSchema,
  bucket: FeedItemBucketSchema.optional(),
  priority: z.number().int().min(0).max(100),
  title: z.string().optional(),
  summary: z.string(),
  timestamp: z.string(),
  status: FeedItemStatusSchema.default("new"),
  expiresAt: z.string().optional(),
  actions: z.array(FeedActionSchema).optional(),
  urgency: FeedItemUrgencySchema.optional(),
  conversationId: z.string().optional(),
  detailPanel: FeedItemDetailPanelSchema.optional(),
  category: FeedItemCategorySchema.optional(),
  noteworthy: z.boolean().optional(),
  fromAssistant: z.boolean().optional(),
  run: FeedItemRunSchema.optional(),
  systemHealth: FeedItemSystemHealthSchema.optional(),
  digest: FeedItemDigestSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Source-conversation classification, enriched at read time. `sourceKey`
  // is the stable filter id — `schedule:<id>` for schedules so each filters
  // separately, otherwise the `sourceType`. `sourceLabel` is the display
  // string (a schedule's name, or a static label like "Heartbeat").
  sourceType: FeedItemSourceTypeSchema.optional(),
  sourceKey: z.string().optional(),
  sourceLabel: z.string().optional(),
  createdAt: z.string(),
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

// ---------------------------------------------------------------------------
// Suggested prompt
// ---------------------------------------------------------------------------

/**
 * Origin of a suggested prompt — whether it was deterministically derived
 * (e.g. from a missing OAuth connection) or generated by the assistant.
 */
export const SuggestedPromptSourceSchema = z.enum([
  "deterministic",
  "assistant",
]);
export type SuggestedPromptSource = z.infer<typeof SuggestedPromptSourceSchema>;

/** A prompt suggestion shown at the top of the Home page. */
export const SuggestedPromptSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  prompt: z.string(),
  source: SuggestedPromptSourceSchema,
});
export type SuggestedPrompt = z.infer<typeof SuggestedPromptSchema>;

// ---------------------------------------------------------------------------
// GET /v1/home/feed
// ---------------------------------------------------------------------------

/** Greeting + relative time-away label + new-item count banner. */
export const ContextBannerSchema = z.object({
  greeting: z.string(),
  timeAwayLabel: z.string(),
  newCount: z.number().int().min(0),
});
export type ContextBanner = z.infer<typeof ContextBannerSchema>;

export const HomeFeedResponseSchema = z.object({
  items: z.array(FeedItemSchema),
  updatedAt: z.string(),
  contextBanner: ContextBannerSchema,
  suggestedPrompts: z.array(SuggestedPromptSchema),
});
export type HomeFeedResponse = z.infer<typeof HomeFeedResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/home/state
// ---------------------------------------------------------------------------

export const FactSchema = z.object({
  id: z.string(),
  category: z.enum(["voice", "world", "priorities"]),
  text: z.string(),
  confidence: z.enum(["strong", "uncertain"]),
  source: z.enum(["onboarding", "inferred"]),
});
export type Fact = z.infer<typeof FactSchema>;
export type FactCategory = Fact["category"];
export type FactConfidence = Fact["confidence"];
export type FactSource = Fact["source"];

export const CapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tier: z.enum(["unlocked", "next-up", "earned"]),
  gate: z.string(),
  unlockHint: z.string().optional(),
  ctaLabel: z.string().optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityTier = Capability["tier"];

export const RelationshipStateSchema = z.object({
  version: z.literal(1),
  assistantId: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  progressPercent: z.number(),
  facts: z.array(FactSchema),
  capabilities: z.array(CapabilitySchema),
  conversationCount: z.number(),
  hatchedDate: z.string(),
  assistantName: z.string(),
  userName: z.string().optional(),
  updatedAt: z.string(),
});
export type RelationshipState = z.infer<typeof RelationshipStateSchema>;
export type RelationshipTier = RelationshipState["tier"];
