/**
 * Shared channel-permission matrix vocabulary (gateway ↔ daemon ↔ web).
 *
 * The permission matrix stores one `RiskThreshold` per
 * (cascade cell × contact-type). Cells cascade from least to most specific:
 * workspace default → adapter → channel-type → channel-ID; resolution picks
 * the most specific cell present. The contact-type axis is the canonical
 * trust class (see `trust-verdict-contract.ts`) — granularity intentionally
 * stops there; there are no per-individual-contact cells.
 *
 * Storage lives in the gateway DB (`channel_permission_overrides`) so the
 * assistant cannot tamper with it, matching `channel_admission_policy` and
 * `auto_approve_thresholds`.
 */

import { z } from "zod";

import { TrustClassSchema } from "./trust-verdict-contract.js";

// ── RiskThreshold ────────────────────────────────────────────────────────────

/**
 * Auto-approve threshold stored per cell: the highest tool `RiskLevel` that
 * auto-approves. Same vocabulary as `auto_approve_thresholds`; the
 * Strict / Conservative / Relaxed / Full-access presets are a presentation
 * layer over these values (`clients/web/src/utils/threshold-presets.ts`).
 */
export const RISK_THRESHOLD_VALUES = ["none", "low", "medium", "high"] as const;

export type RiskThreshold = (typeof RISK_THRESHOLD_VALUES)[number];

export const RiskThresholdSchema = z.enum(RISK_THRESHOLD_VALUES);

export function isRiskThreshold(value: unknown): value is RiskThreshold {
  return RiskThresholdSchema.safeParse(value).success;
}

// ── Cascade scopes ───────────────────────────────────────────────────────────

/** Cascade levels, ordered least → most specific. */
export const CHANNEL_PERMISSION_SCOPES = [
  "workspace",
  "adapter",
  "channel_type",
  "channel",
] as const;

export type ChannelPermissionScope = (typeof CHANNEL_PERMISSION_SCOPES)[number];

export const ChannelPermissionScopeSchema = z.enum(CHANNEL_PERMISSION_SCOPES);

/** Specificity rank per scope — higher wins in cascade resolution. */
export const CHANNEL_PERMISSION_SCOPE_RANK: Record<
  ChannelPermissionScope,
  number
> = {
  workspace: 0,
  adapter: 1,
  channel_type: 2,
  channel: 3,
};

// ── Channel conversation types ───────────────────────────────────────────────

/**
 * Conversation-type axis within an adapter (the "channel-type" cascade
 * level): direct message, private channel/group, public channel. Adapters
 * map their native surfaces onto these three.
 */
export const CHANNEL_CONVERSATION_TYPES = ["dm", "private", "public"] as const;

export type ChannelConversationType =
  (typeof CHANNEL_CONVERSATION_TYPES)[number];

export const ChannelConversationTypeSchema = z.enum(CHANNEL_CONVERSATION_TYPES);

export function isChannelConversationType(
  value: unknown,
): value is ChannelConversationType {
  return ChannelConversationTypeSchema.safeParse(value).success;
}

// ── Cell selector + cell ─────────────────────────────────────────────────────

/**
 * Cascade-key selector, discriminated on scope so each level carries exactly
 * the keys that identify it:
 * - `workspace` — no keys (the global default row).
 * - `adapter` — adapter id (e.g. "slack"). Stored as text; the gateway
 *   validates against its channel registry at write time.
 * - `channel_type` — adapter + conversation type.
 * - `channel` — adapter + channel external id (a specific channel's row;
 *   the id already implies its type).
 *
 * Branches are strict: keys that don't belong to the branch's scope reject
 * rather than being silently stripped. A payload like
 * `{ scope: "workspace", channelExternalId: "C9" }` (stale keys from a scope
 * switch) must fail validation — stripping it would persist a global
 * permission cell the caller intended to be channel-specific.
 */
export const ChannelPermissionSelectorSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }).strict(),
  z
    .object({ scope: z.literal("adapter"), adapter: z.string().min(1) })
    .strict(),
  z
    .object({
      scope: z.literal("channel_type"),
      adapter: z.string().min(1),
      channelType: ChannelConversationTypeSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal("channel"),
      adapter: z.string().min(1),
      channelExternalId: z.string().min(1),
    })
    .strict(),
]);

export type ChannelPermissionSelector = z.infer<
  typeof ChannelPermissionSelectorSchema
>;

/** One matrix cell: a cascade selector × contact-type → RiskThreshold. */
export const ChannelPermissionCellSchema = z.object({
  selector: ChannelPermissionSelectorSchema,
  contactType: TrustClassSchema,
  threshold: RiskThresholdSchema,
  note: z.string().nullish(),
});

export type ChannelPermissionCell = z.infer<typeof ChannelPermissionCellSchema>;

/**
 * Composite key identifying one cell (selector × contact-type) — the shape
 * delete operations take on both the IPC and HTTP surfaces.
 */
export const ChannelPermissionCellKeySchema = z.object({
  selector: ChannelPermissionSelectorSchema,
  contactType: TrustClassSchema,
});

export type ChannelPermissionCellKey = z.infer<
  typeof ChannelPermissionCellKeySchema
>;

/** A persisted cell as read back from the store. */
export interface ChannelPermissionCellRow extends ChannelPermissionCell {
  updatedAt: number;
}

/**
 * Lookup query for cascade resolution: the concrete channel coordinates of
 * an invocation plus the actor's contact-type. Optional keys shrink the
 * cascade — e.g. no `channelExternalId` means channel-scoped cells cannot
 * match.
 */
export const ResolveChannelPermissionRequestSchema = z.object({
  adapter: z.string().min(1),
  channelType: ChannelConversationTypeSchema.optional(),
  channelExternalId: z.string().min(1).optional(),
  contactType: TrustClassSchema,
});

export type ResolveChannelPermissionRequest = z.infer<
  typeof ResolveChannelPermissionRequestSchema
>;

/** Cascade resolution result: the winning threshold and the scope it came from. */
export interface ResolvedChannelPermission {
  threshold: RiskThreshold;
  scope: ChannelPermissionScope;
}
