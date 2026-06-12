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
