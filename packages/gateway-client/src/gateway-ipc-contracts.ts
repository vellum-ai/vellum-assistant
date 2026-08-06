/**
 * Shared IPC contracts for assistant-to-gateway gateway-owned reads.
 */

import { z } from "zod";

export const GATEWAY_LOG_LEVEL_NAMES = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;
export type GatewayLogLevelName = (typeof GATEWAY_LOG_LEVEL_NAMES)[number];

const GatewayLogsTailIpcParamsShape = {
  n: z.number().int().min(1).max(1000).optional(),
  level: z.enum(GATEWAY_LOG_LEVEL_NAMES).optional(),
  module: z.string().optional(),
};

export const GatewayLogsTailIpcParamsSchema = z
  .object(GatewayLogsTailIpcParamsShape)
  .strict()
  .default({});

export type GatewayLogsTailIpcParams = z.infer<
  typeof GatewayLogsTailIpcParamsSchema
>;

export const GatewayLogsTailRouteParamsSchema = z
  .object({
    ...GatewayLogsTailIpcParamsShape,
    n: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

export type GatewayLogsTailRouteParams = z.infer<
  typeof GatewayLogsTailRouteParamsSchema
>;

export const GatewayLogsTailIpcResponseSchema = z.object({
  lines: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});

export type GatewayLogsTailIpcResponse = z.infer<
  typeof GatewayLogsTailIpcResponseSchema
>;

export const TrustRulesListIpcParamsSchema = z
  .object({
    origin: z.string().optional(),
    tool: z.string().optional(),
    include_all: z.boolean().optional(),
    include_deleted: z.boolean().optional(),
  })
  .strict()
  .default({});

export type TrustRulesListIpcParams = z.infer<
  typeof TrustRulesListIpcParamsSchema
>;

export const TrustRuleSchema = z.object({
  id: z.string(),
  tool: z.string(),
  pattern: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  description: z.string(),
  origin: z.enum(["default", "user_defined"]),
  userModified: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TrustRule = z.infer<typeof TrustRuleSchema>;

export const TrustRulesListIpcResponseSchema = z.object({
  rules: z.array(TrustRuleSchema),
});

export type TrustRulesListIpcResponse = z.infer<
  typeof TrustRulesListIpcResponseSchema
>;

export const UpdateContactChannelIpcParamsSchema = z.object({
  contactChannelId: z.string().min(1),
  status: z.string().optional(),
  policy: z.string().optional(),
  reason: z.string().optional(),
});

export type UpdateContactChannelIpcParams = z.infer<
  typeof UpdateContactChannelIpcParamsSchema
>;

export const UpdateContactChannelIpcResponseSchema = z.object({
  ok: z.boolean(),
  // The gateway-native handler owns the full contact payload shape; pass it
  // through verbatim rather than re-declaring channel fields here.
  contact: z.object({}).passthrough().optional(),
});

export type UpdateContactChannelIpcResponse = z.infer<
  typeof UpdateContactChannelIpcResponseSchema
>;

export const MergeContactsIpcParamsSchema = z.object({
  keepId: z.string().min(1),
  mergeId: z.string().min(1),
});

export type MergeContactsIpcParams = z.infer<
  typeof MergeContactsIpcParamsSchema
>;

export const MergeContactsIpcResponseSchema = z.object({
  ok: z.literal(true),
  // The gateway-native handler owns the full contact payload shape; pass it
  // through verbatim rather than re-declaring channel fields here.
  contact: z.object({}).passthrough().optional(),
});

export type MergeContactsIpcResponse = z.infer<
  typeof MergeContactsIpcResponseSchema
>;

export const MarkChannelVerifiedIpcParamsSchema = z.object({
  contactChannelId: z.string().min(1),
  // Audit source for the verification. CLI/session-driven verifications
  // pass "challenge"; manual guardian attest uses "manual" (HTTP path).
  verifiedVia: z.enum(["challenge", "manual"]).default("challenge"),
});

export type MarkChannelVerifiedIpcParams = z.infer<
  typeof MarkChannelVerifiedIpcParamsSchema
>;

export const MarkChannelVerifiedIpcResponseSchema = z.object({
  ok: z.boolean(),
  didWrite: z.boolean(),
  channel: z.object({
    id: z.string(),
    contactId: z.string(),
    type: z.string(),
    address: z.string(),
    status: z.string(),
    verifiedAt: z.number().nullable(),
    verifiedVia: z.string().nullable(),
  }),
});

export type MarkChannelVerifiedIpcResponse = z.infer<
  typeof MarkChannelVerifiedIpcResponseSchema
>;

export const UpsertVerifiedChannelIpcParamsSchema = z.object({
  type: z.string().min(1),
  address: z.string().min(1),
  externalChatId: z.string().min(1),
  displayName: z.string().optional(),
  username: z.string().optional(),
  // Audit source for the verification. Free text (DB column is text) so the
  // invite-activation path can pass "invite"; do not narrow to an enum.
  verifiedVia: z.string().optional(),
  // Target contact to bind the channel to (invite redemption). When set, an
  // existing channel for the same (type,address) under a different contact is
  // reassigned to this contact, mirroring the assistant's
  // reassignConflictingChannels.
  contactId: z.string().min(1).optional(),
  // Relax the revoked refusal guard so a valid invite can reactivate a revoked
  // member. Blocked actors are refused regardless.
  allowRevokedReactivation: z.boolean().optional(),
});

export type UpsertVerifiedChannelIpcParams = z.infer<
  typeof UpsertVerifiedChannelIpcParamsSchema
>;

export const UpsertVerifiedChannelIpcResponseSchema = z.object({
  ok: z.boolean(),
  verified: z.boolean(),
  // Present only when verified — a blocked/revoked skip omits the channel.
  channel: z
    .object({
      id: z.string(),
      contactId: z.string(),
      type: z.string(),
      address: z.string(),
      status: z.string(),
      verifiedAt: z.number().nullable(),
      verifiedVia: z.string().nullable(),
    })
    .optional(),
});

export type UpsertVerifiedChannelIpcResponse = z.infer<
  typeof UpsertVerifiedChannelIpcResponseSchema
>;

export const CreateContactIpcResponseSchema = z.object({
  contactId: z.string(),
  // Gateway channel id for the (channelType, address) pair, resolved from the
  // gateway DB (source of truth). Empty when the read-back found no row.
  channelId: z.string(),
});

export type CreateContactIpcResponse = z.infer<
  typeof CreateContactIpcResponseSchema
>;

export const MarkChannelRevokedIpcParamsSchema = z.object({
  contactChannelId: z.string().min(1),
  // Audit reason for the downgrade. The verification-revoke flow passes
  // "guardian_binding_revoked", the only reason allowed to downgrade a
  // guardian channel (guardian guard, invariant 4).
  reason: z.string().optional(),
});

export type MarkChannelRevokedIpcParams = z.infer<
  typeof MarkChannelRevokedIpcParamsSchema
>;

export const MarkChannelRevokedIpcResponseSchema = z.object({
  ok: z.boolean(),
  didWrite: z.boolean(),
  channel: z.object({
    id: z.string(),
    contactId: z.string(),
    type: z.string(),
    address: z.string(),
    status: z.string(),
    revokedReason: z.string().nullable(),
  }),
});

export type MarkChannelRevokedIpcResponse = z.infer<
  typeof MarkChannelRevokedIpcResponseSchema
>;

export const ContactReadChannelSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  externalUserId: z.string().nullable(),
  status: z.string(),
  policy: z.string(),
  verifiedAt: z.number().nullable(),
  verifiedVia: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  interactionCount: z.number().nullable(),
  lastInteraction: z.number().nullable(),
  revokedReason: z.string().nullable(),
  blockedReason: z.string().nullable(),
});

export type ContactReadChannel = z.infer<typeof ContactReadChannelSchema>;

export const ContactReadSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
  notes: z.string().nullable().optional(),
  contactType: z.string().nullable().optional(),
  lastInteraction: z.number().nullable().optional(),
  interactionCount: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  channels: z.array(ContactReadChannelSchema),
});

export type ContactRead = z.infer<typeof ContactReadSchema>;

export const AssistantContactMetadataSchema = z.object({
  contactId: z.string(),
  species: z.string(),
  metadata: z.object({}).passthrough().nullable(),
});

export type AssistantContactMetadata = z.infer<
  typeof AssistantContactMetadataSchema
>;

export const ListContactsIpcParamsSchema = z
  .object({
    limit: z.number().optional(),
    role: z.string().optional(),
    // Restrict the read to these contact ids (any order). Used by the daemon to
    // batch-hydrate gateway-owned telemetry onto daemon-native filtered/search
    // results without re-implementing search in the gateway. When present,
    // `role`/`limit` filtering is bypassed — the id set is the filter.
    ids: z.array(z.string()).optional(),
  })
  .strict()
  .default({});

export type ListContactsIpcParams = z.infer<typeof ListContactsIpcParamsSchema>;

export const ListContactsIpcResponseSchema = z.object({
  ok: z.boolean(),
  contacts: z.array(ContactReadSchema),
});

export type ListContactsIpcResponse = z.infer<
  typeof ListContactsIpcResponseSchema
>;

export const GetContactIpcParamsSchema = z
  .object({ contactId: z.string() })
  .strict();

export type GetContactIpcParams = z.infer<typeof GetContactIpcParamsSchema>;

export const GetContactIpcResponseSchema = z.object({
  ok: z.boolean(),
  contact: ContactReadSchema,
  assistantMetadata: AssistantContactMetadataSchema.optional(),
});

export type GetContactIpcResponse = z.infer<typeof GetContactIpcResponseSchema>;

export const GetGuardianContactIpcParamsSchema = z
  .object({})
  .strict()
  .default({});

export type GetGuardianContactIpcParams = z.infer<
  typeof GetGuardianContactIpcParamsSchema
>;

export const GetGuardianContactIpcResponseSchema = z.object({
  ok: z.boolean(),
  guardianIds: z.array(z.string()),
});

export type GetGuardianContactIpcResponse = z.infer<
  typeof GetGuardianContactIpcResponseSchema
>;
