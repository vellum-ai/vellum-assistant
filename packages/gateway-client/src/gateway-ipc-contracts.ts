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
  interactionCount: z.number(),
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
  interactionCount: z.number(),
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
    contactType: z.string().optional(),
  })
  .strict()
  .default({});

export type ListContactsIpcParams = z.infer<
  typeof ListContactsIpcParamsSchema
>;

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

export type GetContactIpcResponse = z.infer<
  typeof GetContactIpcResponseSchema
>;
