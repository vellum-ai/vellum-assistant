/**
 * Shared guardian-request contracts for the gateway-native guardian-request
 * lifecycle (ATL-463).
 *
 * The wire DTOs and the `guardian_requests_*` IPC request/response schemas
 * are shared so gateway and daemon converge on one source of truth instead of
 * drifting copies. Field notes vs the legacy assistant table
 * (`canonical_guardian_requests`): `sourceConversationId` renames
 * `conversation_id`, `requestTrigger` renames the `trigger` field (column
 * `request_trigger`), and `sourceType` is COMPUTED by the gateway mapper from
 * `sourceChannel` (phone → voice, vellum → desktop, else channel) — it is not
 * stored.
 *
 * Method names deliberately use the `guardian_requests_` prefix — the
 * daemon's client-facing HTTP surface owns the distinct `guardian_actions_*`
 * operationIds (`guardian_actions_pending` / `guardian_actions_decision`),
 * which do not change.
 */

import { z } from "zod";

import {
  CreateOutboundSessionIpcParamsSchema,
  CreateOutboundSessionIpcResponseSchema,
} from "./verification-session-contract.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const GUARDIAN_REQUEST_STATUS_VALUES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;

export const GuardianRequestStatusSchema = z.enum(
  GUARDIAN_REQUEST_STATUS_VALUES,
);

export type GuardianRequestStatus = z.infer<typeof GuardianRequestStatusSchema>;

const GUARDIAN_REQUEST_KIND_VALUES = [
  "access_request",
  "tool_approval",
  "tool_grant_request",
  "pending_question",
] as const;

export const GuardianRequestKindSchema = z.enum(GUARDIAN_REQUEST_KIND_VALUES);

export type GuardianRequestKind = z.infer<typeof GuardianRequestKindSchema>;

const GUARDIAN_REQUEST_SOURCE_TYPE_VALUES = [
  "voice",
  "desktop",
  "channel",
] as const;

export const GuardianRequestSourceTypeSchema = z.enum(
  GUARDIAN_REQUEST_SOURCE_TYPE_VALUES,
);

export type GuardianRequestSourceType = z.infer<
  typeof GuardianRequestSourceTypeSchema
>;

// ---------------------------------------------------------------------------
// Wire DTOs
// ---------------------------------------------------------------------------

/**
 * Guardian request as carried on the daemon ↔ gateway wire. The gateway
 * store's row type aliases this DTO (minus the computed `sourceType`), so
 * store reads serialize onto the wire unchanged.
 */
export const GuardianRequestSchema = z.object({
  id: z.string(),
  kind: GuardianRequestKindSchema,
  /** Computed from `sourceChannel` by the gateway mapper — not stored. */
  sourceType: GuardianRequestSourceTypeSchema,
  sourceChannel: z.string().nullable(),
  sourceConversationId: z.string().nullable(),
  requesterExternalUserId: z.string().nullable(),
  requesterChatId: z.string().nullable(),
  guardianExternalUserId: z.string().nullable(),
  guardianPrincipalId: z.string().nullable(),
  callSessionId: z.string().nullable(),
  pendingQuestionId: z.string().nullable(),
  questionText: z.string().nullable(),
  requestCode: z.string().nullable(),
  toolName: z.string().nullable(),
  inputDigest: z.string().nullable(),
  commandPreview: z.string().nullable(),
  riskLevel: z.string().nullable(),
  activityText: z.string().nullable(),
  executionTarget: z.string().nullable(),
  /** JSON-encoded requester identity signals captured at creation. */
  requesterSignals: z.string().nullable(),
  /** What prompted an access request: `denied` (default) or `admitted`. */
  requestTrigger: z.string().nullable(),
  status: GuardianRequestStatusSchema,
  answerText: z.string().nullable(),
  decidedByExternalUserId: z.string().nullable(),
  decidedByPrincipalId: z.string().nullable(),
  followupState: z.string().nullable(),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type GuardianRequestWire = z.infer<typeof GuardianRequestSchema>;

/** Guardian-request delivery record as carried on the wire. */
export const GuardianRequestDeliverySchema = z.object({
  id: z.string(),
  requestId: z.string(),
  destinationChannel: z.string(),
  destinationConversationId: z.string().nullable(),
  destinationChatId: z.string().nullable(),
  destinationMessageId: z.string().nullable(),
  status: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type GuardianRequestDeliveryWire = z.infer<
  typeof GuardianRequestDeliverySchema
>;

// ---------------------------------------------------------------------------
// IPC methods
// ---------------------------------------------------------------------------

/**
 * Gateway IPC method names for the guardian-request lifecycle. Keys match the
 * daemon-side wrapper names; values are the wire method strings.
 *
 * Destination lookups are split into `get_by_destination_message` (single
 * nullable DTO — reaction routing) and `list_pending_by_destination` (DTO
 * array — reply routing by chat or conversation) so each response schema has
 * exactly one shape instead of a params-dependent polymorphic result.
 */
export const GUARDIAN_REQUESTS_IPC_METHODS = {
  create: "guardian_requests_create",
  get: "guardian_requests_get",
  getByCode: "guardian_requests_get_by_code",
  list: "guardian_requests_list",
  update: "guardian_requests_update",
  decide: "guardian_requests_decide",
  reopen: "guardian_requests_reopen",
  expire: "guardian_requests_expire",
  expireInteractionBound: "guardian_requests_expire_interaction_bound",
  sweepExpired: "guardian_requests_sweep_expired",
  createDelivery: "guardian_requests_create_delivery",
  updateDelivery: "guardian_requests_update_delivery",
  listDeliveries: "guardian_requests_list_deliveries",
  getByDestinationMessage: "guardian_requests_get_by_destination_message",
  listPendingByDestination: "guardian_requests_list_pending_by_destination",
  listPendingByScope: "guardian_requests_list_pending_by_scope",
  inScope: "guardian_requests_in_scope",
} as const;

export type GuardianRequestsIpcMethod =
  (typeof GUARDIAN_REQUESTS_IPC_METHODS)[keyof typeof GUARDIAN_REQUESTS_IPC_METHODS];

// ---------------------------------------------------------------------------
// Shared IPC response schemas
// ---------------------------------------------------------------------------

/** Shared response for single-request lookups: the wire DTO or null. */
export const GuardianRequestLookupIpcResponseSchema =
  GuardianRequestSchema.nullable();

export type GuardianRequestLookupIpcResponse = z.infer<
  typeof GuardianRequestLookupIpcResponseSchema
>;

/** Shared response for request list reads. */
export const GuardianRequestListIpcResponseSchema =
  z.array(GuardianRequestSchema);

export type GuardianRequestListIpcResponse = z.infer<
  typeof GuardianRequestListIpcResponseSchema
>;

/** Shared minimal ack for mutations (failures travel as errors). */
export const GuardianRequestMutationIpcResponseSchema = z.object({
  ok: z.literal(true),
});

export type GuardianRequestMutationIpcResponse = z.infer<
  typeof GuardianRequestMutationIpcResponseSchema
>;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Request for `guardian_requests_create`. `id` is REQUIRED and
 * caller-supplied — request ids are load-bearing (deterministic
 * access-request ids; `tool_approval` rows reuse the pending-interaction
 * requestId as PK). `requestCode` is generated gateway-side when omitted.
 * No `sourceType`: the gateway derives it from `sourceChannel`.
 */
export const CreateGuardianRequestIpcParamsSchema = z.object({
  id: z.string().min(1),
  kind: GuardianRequestKindSchema,
  sourceChannel: z.string().optional(),
  sourceConversationId: z.string().optional(),
  requesterExternalUserId: z.string().optional(),
  requesterChatId: z.string().optional(),
  guardianExternalUserId: z.string().optional(),
  guardianPrincipalId: z.string().optional(),
  callSessionId: z.string().optional(),
  pendingQuestionId: z.string().optional(),
  questionText: z.string().optional(),
  requestCode: z.string().optional(),
  toolName: z.string().optional(),
  inputDigest: z.string().optional(),
  commandPreview: z.string().optional(),
  riskLevel: z.string().optional(),
  activityText: z.string().optional(),
  executionTarget: z.string().optional(),
  requesterSignals: z.string().optional(),
  requestTrigger: z.string().optional(),
  status: GuardianRequestStatusSchema.optional(),
  answerText: z.string().optional(),
  decidedByExternalUserId: z.string().optional(),
  decidedByPrincipalId: z.string().optional(),
  followupState: z.string().optional(),
  expiresAt: z.number().optional(),
});

export type CreateGuardianRequestIpcParams = z.infer<
  typeof CreateGuardianRequestIpcParamsSchema
>;

/** Response for `guardian_requests_create`: the created wire DTO. */
export const CreateGuardianRequestIpcResponseSchema = GuardianRequestSchema;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Request for `guardian_requests_get`. */
export const GetGuardianRequestIpcParamsSchema = z.object({
  id: z.string().min(1),
});

export type GetGuardianRequestIpcParams = z.infer<
  typeof GetGuardianRequestIpcParamsSchema
>;

/** Request for `guardian_requests_get_by_code` (pending requests only). */
export const GetGuardianRequestByCodeIpcParamsSchema = z.object({
  code: z.string().min(1),
});

export type GetGuardianRequestByCodeIpcParams = z.infer<
  typeof GetGuardianRequestByCodeIpcParamsSchema
>;

/**
 * Filters for `guardian_requests_list`. `sourceType` is translated
 * gateway-side into a `source_channel` predicate (the column is not stored).
 */
export const ListGuardianRequestsIpcParamsSchema = z.object({
  status: GuardianRequestStatusSchema.optional(),
  guardianExternalUserId: z.string().optional(),
  guardianPrincipalId: z.string().optional(),
  requesterExternalUserId: z.string().optional(),
  sourceConversationId: z.string().optional(),
  sourceType: GuardianRequestSourceTypeSchema.optional(),
  sourceChannel: z.string().optional(),
  kind: GuardianRequestKindSchema.optional(),
  toolName: z.string().optional(),
});

export type ListGuardianRequestsIpcParams = z.infer<
  typeof ListGuardianRequestsIpcParamsSchema
>;

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Partial patch for `guardian_requests_update`. */
export const GuardianRequestPatchSchema = z.object({
  status: GuardianRequestStatusSchema.optional(),
  answerText: z.string().optional(),
  decidedByExternalUserId: z.string().optional(),
  decidedByPrincipalId: z.string().optional(),
  followupState: z.string().nullable().optional(),
  expiresAt: z.number().optional(),
});

export type GuardianRequestPatch = z.infer<typeof GuardianRequestPatchSchema>;

/** Request for `guardian_requests_update`. */
export const UpdateGuardianRequestIpcParamsSchema = z.object({
  id: z.string().min(1),
  patch: GuardianRequestPatchSchema,
});

export type UpdateGuardianRequestIpcParams = z.infer<
  typeof UpdateGuardianRequestIpcParamsSchema
>;

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/**
 * ACL side effect the gateway applies in the SAME transaction as the decision
 * CAS. Each variant mirrors the daemon relay it replaces:
 * - `activate_member` → `activateMemberChannel` (`upsert_verified_channel`).
 * - `seed_unverified` → `seedUnverifiedMemberChannel` (`create_contact`).
 * - `block` → `blockSenderChannel` (`create_contact` + `mark_channel_revoked`).
 * - `mint_outbound_session` → `createOutboundSession` params (verify_code).
 */
export const GuardianRequestAclOutcomeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("activate_member"),
    sourceChannel: z.string().min(1),
    externalUserId: z.string().optional(),
    externalChatId: z.string().optional(),
    contactId: z.string().optional(),
    displayName: z.string().optional(),
    username: z.string().optional(),
    verifiedVia: z.string().optional(),
  }),
  z.object({
    type: z.literal("seed_unverified"),
    sourceChannel: z.string().min(1),
    externalUserId: z.string().min(1),
    displayName: z.string().optional(),
  }),
  z.object({
    type: z.literal("block"),
    sourceChannel: z.string().min(1),
    externalUserId: z.string().min(1),
    displayName: z.string().optional(),
    /** Audit reason written to the gateway channel's revokedReason. */
    reason: z.string().optional(),
  }),
  CreateOutboundSessionIpcParamsSchema.extend({
    type: z.literal("mint_outbound_session"),
  }),
]);

export type GuardianRequestAclOutcome = z.infer<
  typeof GuardianRequestAclOutcomeSchema
>;

/** Request for `guardian_requests_decide` (status CAS + optional ACL outcome). */
export const DecideGuardianRequestIpcParamsSchema = z.object({
  id: z.string().min(1),
  expectedStatus: GuardianRequestStatusSchema,
  status: GuardianRequestStatusSchema,
  decidedByExternalUserId: z.string().optional(),
  decidedByPrincipalId: z.string().optional(),
  answerText: z.string().optional(),
  aclOutcome: GuardianRequestAclOutcomeSchema.optional(),
});

export type DecideGuardianRequestIpcParams = z.infer<
  typeof DecideGuardianRequestIpcParamsSchema
>;

/**
 * Response for `guardian_requests_decide`. A CAS miss returns
 * `status_conflict` with zero side effects (first-writer-wins). On success
 * `mintedSession` is present iff the outcome was `mint_outbound_session` —
 * the raw secret transits back for daemon-owned code delivery.
 */
export const DecideGuardianRequestIpcResponseSchema = z.discriminatedUnion(
  "applied",
  [
    z.object({
      applied: z.literal(true),
      request: GuardianRequestSchema,
      mintedSession: CreateOutboundSessionIpcResponseSchema.optional(),
    }),
    z.object({
      applied: z.literal(false),
      reason: z.literal("status_conflict"),
    }),
  ],
);

export type DecideGuardianRequestIpcResponse = z.infer<
  typeof DecideGuardianRequestIpcResponseSchema
>;

// ---------------------------------------------------------------------------
// Reopen / expiry
// ---------------------------------------------------------------------------

/**
 * Request for `guardian_requests_reopen` (terminal → pending CAS). Kept for
 * the migration flip window; deleted once genuinely unused.
 */
export const ReopenGuardianRequestIpcParamsSchema = z.object({
  id: z.string().min(1),
  fromStatus: GuardianRequestStatusSchema,
});

export type ReopenGuardianRequestIpcParams = z.infer<
  typeof ReopenGuardianRequestIpcParamsSchema
>;

/**
 * Request for `guardian_requests_expire` (CAS pending → expired; also expires
 * the request's deliveries).
 */
export const ExpireGuardianRequestIpcParamsSchema = z.object({
  id: z.string().min(1),
});

export type ExpireGuardianRequestIpcParams = z.infer<
  typeof ExpireGuardianRequestIpcParamsSchema
>;

/**
 * Request for `guardian_requests_expire_interaction_bound` — daemon boot:
 * interaction-bound kinds (`tool_approval`, `pending_question`) die with the
 * daemon's in-memory pendingInteractions map, plus persistent kinds already
 * past their `expiresAt`. Never run on gateway restart.
 */
export const ExpireInteractionBoundIpcParamsSchema = z.object({});

export type ExpireInteractionBoundIpcParams = z.infer<
  typeof ExpireInteractionBoundIpcParamsSchema
>;

/** Response for `guardian_requests_expire_interaction_bound`. */
export const ExpireInteractionBoundIpcResponseSchema = z.object({
  expired: z.number().int(),
});

export type ExpireInteractionBoundIpcResponse = z.infer<
  typeof ExpireInteractionBoundIpcResponseSchema
>;

/** Request for `guardian_requests_sweep_expired` (`now` defaults gateway-side). */
export const SweepExpiredGuardianRequestsIpcParamsSchema = z.object({
  now: z.number().optional(),
});

export type SweepExpiredGuardianRequestsIpcParams = z.infer<
  typeof SweepExpiredGuardianRequestsIpcParamsSchema
>;

/**
 * Response for `guardian_requests_sweep_expired`: ids of requests the sweep
 * expired, for daemon-side notification/card-withdrawal fan-out.
 */
export const SweepExpiredGuardianRequestsIpcResponseSchema = z.object({
  expired: z.array(z.string()),
});

export type SweepExpiredGuardianRequestsIpcResponse = z.infer<
  typeof SweepExpiredGuardianRequestsIpcResponseSchema
>;

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** Request for `guardian_requests_create_delivery` (`id` generated when omitted). */
export const CreateGuardianRequestDeliveryIpcParamsSchema = z.object({
  id: z.string().optional(),
  requestId: z.string().min(1),
  destinationChannel: z.string().min(1),
  destinationConversationId: z.string().optional(),
  destinationChatId: z.string().optional(),
  destinationMessageId: z.string().optional(),
  status: z.string().optional(),
});

export type CreateGuardianRequestDeliveryIpcParams = z.infer<
  typeof CreateGuardianRequestDeliveryIpcParamsSchema
>;

/** Response for `guardian_requests_create_delivery`: the created delivery. */
export const CreateGuardianRequestDeliveryIpcResponseSchema =
  GuardianRequestDeliverySchema;

/** Request for `guardian_requests_update_delivery`. */
export const UpdateGuardianRequestDeliveryIpcParamsSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    status: z.string().optional(),
    destinationMessageId: z.string().optional(),
  }),
});

export type UpdateGuardianRequestDeliveryIpcParams = z.infer<
  typeof UpdateGuardianRequestDeliveryIpcParamsSchema
>;

/** Request for `guardian_requests_list_deliveries`. */
export const ListGuardianRequestDeliveriesIpcParamsSchema = z.object({
  requestId: z.string().min(1),
});

export type ListGuardianRequestDeliveriesIpcParams = z.infer<
  typeof ListGuardianRequestDeliveriesIpcParamsSchema
>;

/** Response for `guardian_requests_list_deliveries`. */
export const GuardianRequestDeliveryListIpcResponseSchema = z.array(
  GuardianRequestDeliverySchema,
);

export type GuardianRequestDeliveryListIpcResponse = z.infer<
  typeof GuardianRequestDeliveryListIpcResponseSchema
>;

// ---------------------------------------------------------------------------
// Destination + scope lookups
// ---------------------------------------------------------------------------

/**
 * Request for `guardian_requests_get_by_destination_message` — reaction
 * routing: recover the pending request whose delivered card is the reacted-to
 * message.
 */
export const GetGuardianRequestByDestinationMessageIpcParamsSchema = z.object({
  channel: z.string().min(1),
  chatId: z.string().min(1),
  messageId: z.string().min(1),
});

export type GetGuardianRequestByDestinationMessageIpcParams = z.infer<
  typeof GetGuardianRequestByDestinationMessageIpcParamsSchema
>;

/**
 * Request for `guardian_requests_list_pending_by_destination`. Two forms:
 * by destination conversation (`conversationId`, optionally narrowed by
 * `channel`) or by destination chat (`channel` + `chatId`).
 */
export const ListPendingGuardianRequestsByDestinationIpcParamsSchema = z
  .object({
    channel: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
  })
  .refine(
    (params) =>
      Boolean(params.conversationId) ||
      Boolean(params.channel && params.chatId),
    { message: "conversationId or channel+chatId required" },
  );

export type ListPendingGuardianRequestsByDestinationIpcParams = z.infer<
  typeof ListPendingGuardianRequestsByDestinationIpcParamsSchema
>;

/**
 * Request for `guardian_requests_list_pending_by_scope`: pending requests
 * sourced from OR delivered to the conversation, deduplicated, non-expired.
 */
export const ListPendingGuardianRequestsByScopeIpcParamsSchema = z.object({
  conversationId: z.string().min(1),
  channel: z.string().optional(),
});

export type ListPendingGuardianRequestsByScopeIpcParams = z.infer<
  typeof ListPendingGuardianRequestsByScopeIpcParamsSchema
>;

/**
 * Request for `guardian_requests_in_scope`: is a decision from this
 * conversation allowed for the request (source match, or delivery match
 * optionally narrowed by `channel`)?
 */
export const GuardianRequestInScopeIpcParamsSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  channel: z.string().optional(),
});

export type GuardianRequestInScopeIpcParams = z.infer<
  typeof GuardianRequestInScopeIpcParamsSchema
>;

/** Response for `guardian_requests_in_scope`. */
export const GuardianRequestInScopeIpcResponseSchema = z.object({
  inScope: z.boolean(),
});

export type GuardianRequestInScopeIpcResponse = z.infer<
  typeof GuardianRequestInScopeIpcResponseSchema
>;
