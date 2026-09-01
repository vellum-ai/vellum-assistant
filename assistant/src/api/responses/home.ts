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

/** High-level kind of feed item — drives which client view renders it. */
export const FeedItemTypeSchema = z.literal("notification");
export type FeedItemType = z.infer<typeof FeedItemTypeSchema>;

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

/**
 * Fixes a client can perform for the condition a notification reports.
 *
 * Distinct from {@link FeedActionSchema}, which seeds a conversation: a
 * remediation is work the client does itself, with no turn and no model in
 * the loop. It exists because a notification that reports a broken thing and
 * offers no way to repair it is a dead end, and every such condition would
 * otherwise grow its own card with its own button.
 *
 * The producer names the fix; renderers look it up and render. A client that
 * does not know an action renders nothing rather than guessing, so adding one
 * never breaks an older client.
 *
 * Adding a remediation is two edits: a value here plus the branch that
 * attaches it in `notifications/home-feed-side-effect.ts`, and a handler in
 * the client's remediation registry. Never a new card, and never a renderer
 * inferring a fix from payload fields.
 */
export const FeedRemediationActionSchema = z.enum([
  /**
   * Ask the platform for a replacement Vellum-managed inference credential.
   * The assistant cannot mint this credential, so the repair belongs to a
   * signed-in client.
   */
  "reprovision_managed_credential",
]);
export type FeedRemediationAction = z.infer<typeof FeedRemediationActionSchema>;

/**
 * A remediation offered on a feed item.
 *
 * `label` is authored by the producer, which is the side that knows what the
 * fix does. Clients render it rather than composing their own, so the button
 * cannot drift from the condition it repairs.
 */
export const FeedRemediationSchema = z.object({
  action: FeedRemediationActionSchema,
  label: z.string(),
  /**
   * Which instance the fix applies to, when the condition can occur more than
   * once. A workspace has one managed inference credential, but several OAuth
   * connections and several channels, so a repair for those has to say which
   * one it repairs or it cannot be offered at all.
   *
   * Free-form because each action's handler is the only thing that reads it
   * and the only thing that can validate it. Keep the keys stable, since a
   * client that shipped before an action gained a parameter still sends what
   * it was given.
   */
  params: z.record(z.string(), z.string()).optional(),
});
export type FeedRemediation = z.infer<typeof FeedRemediationSchema>;

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
 * Canonical guardian-request status projected onto a feed item.
 *
 * Values mirror `GuardianRequestStatusSchema` in
 * `@vellumai/gateway-client` (this file is copied verbatim into client
 * packages, so it cannot import the contract; the daemon's projection
 * writer asserts the two stay aligned at compile time).
 */
export const FeedItemGuardianStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type FeedItemGuardianStatus = z.infer<
  typeof FeedItemGuardianStatusSchema
>;

/** Whether the guardian is being asked to approve or to answer. */
export const FeedItemGuardianIntentSchema = z.enum(["approval", "question"]);
export type FeedItemGuardianIntent = z.infer<
  typeof FeedItemGuardianIntentSchema
>;

/**
 * Read projection of one canonical guardian request onto its feed item.
 *
 * The feed item carrying this is the request's single "Needs attention"
 * home: exactly one item per `requestId`, kept current by the daemon's
 * status fan-out. Clients derive every affordance from `status` +
 * `intent`: a `pending` approval offers Approve/Reject (via
 * `POST /v1/guardian-actions/decision`), a `pending` question routes to
 * the source conversation, and a terminal status renders as a receipt.
 * Nothing here is an independent delivery record; it restates gateway
 * `guardian_requests` state and is never a source of truth on its own.
 */
export const FeedItemGuardianRequestSchema = z.object({
  requestId: z.string(),
  /**
   * Guardian request kind (`tool_approval`, `tool_grant_request`,
   * `pending_question`, `access_request`). A string rather than an enum so
   * rows written by a newer daemon still parse.
   */
  kind: z.string(),
  intent: FeedItemGuardianIntentSchema,
  status: FeedItemGuardianStatusSchema,
  /** Display name or identifier of the requester (e.g. "Alice"). */
  requesterLabel: z.string().optional(),
  /** Tool the request is about, when it is a tool approval/grant. */
  toolName: z.string().optional(),
  /** Channel the request originated from (e.g. "slack"). */
  sourceChannel: z.string().optional(),
  /** Display label for the originating chat (e.g. "#user-feedback"). */
  sourceContextLabel: z.string().optional(),
  /** Permalink to the originating channel message, when derivable. */
  sourceUrl: z.string().optional(),
  /** Action that resolved the request, for terminal statuses. */
  decidedAction: z.string().optional(),
  /** ISO-8601 time the request reached its terminal status. */
  decidedAt: z.string().optional(),
  /**
   * Why a non-decision terminal status was reached (e.g. `superseded`
   * when a newer message auto-denied the request). Display-only.
   */
  terminalReason: z.string().optional(),
});
export type FeedItemGuardianRequest = z.infer<
  typeof FeedItemGuardianRequestSchema
>;

/**
 * A single item rendered in the Home feed.
 *
 * Notes:
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
 */
export const FeedItemSchema = z.object({
  id: z.string(),
  type: FeedItemTypeSchema,
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
  // A fix the client can run for the condition this item reports; see
  // FeedRemediationSchema. Independent of `detailPanel`: which card renders
  // the item and whether the item can be repaired are separate questions, so
  // any panel kind can carry one.
  remediation: FeedRemediationSchema.optional(),
  // Present only on the canonical "Needs attention" item projecting a
  // guardian request; see FeedItemGuardianRequestSchema.
  guardianRequest: FeedItemGuardianRequestSchema.optional(),
  category: FeedItemCategorySchema.optional(),
  noteworthy: z.boolean().optional(),
  fromAssistant: z.boolean().optional(),
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

/**
 * `terminalReason` value for a request auto-denied because a newer
 * inbound message superseded it. Shared by the daemon rails that record
 * it and the clients that render "Superseded" instead of a rejection.
 */
export const GUARDIAN_TERMINAL_REASON_SUPERSEDED = "superseded";

/**
 * Whether a feed item is the live projection of an unresolved guardian
 * request. Shared by the daemon (bulk-dismiss protection in the feed
 * writer) and clients (visibility carve-outs, bulk-action id sets) so
 * "pending guardian item" means the same thing on both sides: such an
 * item must stay actionable until the canonical request resolves, and
 * only its terminal receipt is ordinarily clearable.
 */
export function isPendingGuardianFeedItem(
  item: Pick<FeedItem, "guardianRequest">,
): boolean {
  return item.guardianRequest?.status === "pending";
}

/**
 * Whether this item is waiting on the person reading it.
 *
 * Two shapes qualify: a guardian request nobody has answered, and an item
 * carrying a repair nobody has run. Both mean the same thing to a reader
 * scanning the bell, so both take the same callout rather than the callout
 * being a guardian-only decoration.
 *
 * An item merely reporting something bad does not qualify. The callout says
 * "this is blocked on you", so attaching it to a notification with nothing to
 * do would teach readers to ignore it.
 */
export function feedItemAwaitsUserAction(
  item: Pick<FeedItem, "guardianRequest" | "remediation">,
): boolean {
  return isPendingGuardianFeedItem(item) || item.remediation !== undefined;
}

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
