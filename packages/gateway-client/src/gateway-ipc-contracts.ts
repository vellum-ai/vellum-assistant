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
