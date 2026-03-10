import { z } from "zod";

export const IngressWebhookConfigSchema = z.object({
  secret: z
    .string({ error: "ingress.webhook.secret must be a string" })
    .default(""),
  timeoutMs: z
    .number({ error: "ingress.webhook.timeoutMs must be a number" })
    .int("ingress.webhook.timeoutMs must be an integer")
    .positive("ingress.webhook.timeoutMs must be a positive integer")
    .default(30_000),
  maxRetries: z
    .number({ error: "ingress.webhook.maxRetries must be a number" })
    .int("ingress.webhook.maxRetries must be an integer")
    .nonnegative("ingress.webhook.maxRetries must be a non-negative integer")
    .default(2),
  initialBackoffMs: z
    .number({ error: "ingress.webhook.initialBackoffMs must be a number" })
    .int("ingress.webhook.initialBackoffMs must be an integer")
    .positive("ingress.webhook.initialBackoffMs must be a positive integer")
    .default(500),
  maxPayloadBytes: z
    .number({ error: "ingress.webhook.maxPayloadBytes must be a number" })
    .int("ingress.webhook.maxPayloadBytes must be an integer")
    .positive("ingress.webhook.maxPayloadBytes must be a positive integer")
    .default(1_048_576),
});

export const IngressRateLimitConfigSchema = z.object({
  maxRequestsPerMinute: z
    .number({
      error: "ingress.rateLimit.maxRequestsPerMinute must be a number",
    })
    .int("ingress.rateLimit.maxRequestsPerMinute must be an integer")
    .nonnegative(
      "ingress.rateLimit.maxRequestsPerMinute must be a non-negative integer",
    )
    .default(0),
  maxRequestsPerHour: z
    .number({ error: "ingress.rateLimit.maxRequestsPerHour must be a number" })
    .int("ingress.rateLimit.maxRequestsPerHour must be an integer")
    .nonnegative(
      "ingress.rateLimit.maxRequestsPerHour must be a non-negative integer",
    )
    .default(0),
});

const IngressBaseSchema = z.object({
  enabled: z.boolean({ error: "ingress.enabled must be a boolean" }).optional(),
  publicBaseUrl: z
    .string({ error: "ingress.publicBaseUrl must be a string" })
    .refine(
      (val) => val === "" || /^https?:\/\//i.test(val),
      "ingress.publicBaseUrl must be an absolute URL starting with http:// or https://",
    )
    .default(""),
  webhook: IngressWebhookConfigSchema.default(
    IngressWebhookConfigSchema.parse({}),
  ),
  rateLimit: IngressRateLimitConfigSchema.default(
    IngressRateLimitConfigSchema.parse({}),
  ),
  shutdownDrainMs: z
    .number({ error: "ingress.shutdownDrainMs must be a number" })
    .int("ingress.shutdownDrainMs must be an integer")
    .nonnegative("ingress.shutdownDrainMs must be a non-negative integer")
    .default(5_000),
});

export const IngressConfigSchema = IngressBaseSchema.default(
  IngressBaseSchema.parse({}),
).transform((val) => ({
  ...val,
  enabled: val.enabled,
}));

export type IngressWebhookConfig = z.infer<typeof IngressWebhookConfigSchema>;
export type IngressRateLimitConfig = z.infer<
  typeof IngressRateLimitConfigSchema
>;
export type IngressConfig = z.infer<typeof IngressConfigSchema>;
