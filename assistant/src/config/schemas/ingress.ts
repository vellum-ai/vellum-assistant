import { z } from "zod";

const IngressWebhookConfigSchema = z
  .object({
    secret: z
      .string({ error: "ingress.webhook.secret must be a string" })
      .default("")
      .describe("Shared secret for HMAC webhook signature verification"),
    timeoutMs: z
      .number({ error: "ingress.webhook.timeoutMs must be a number" })
      .int("ingress.webhook.timeoutMs must be an integer")
      .positive("ingress.webhook.timeoutMs must be a positive integer")
      .default(30_000)
      .describe(
        "Timeout for outgoing webhook delivery requests in milliseconds",
      ),
    maxRetries: z
      .number({ error: "ingress.webhook.maxRetries must be a number" })
      .int("ingress.webhook.maxRetries must be an integer")
      .nonnegative("ingress.webhook.maxRetries must be a non-negative integer")
      .default(2)
      .describe(
        "Maximum number of retry attempts for failed webhook deliveries",
      ),
    initialBackoffMs: z
      .number({ error: "ingress.webhook.initialBackoffMs must be a number" })
      .int("ingress.webhook.initialBackoffMs must be an integer")
      .positive("ingress.webhook.initialBackoffMs must be a positive integer")
      .default(500)
      .describe(
        "Initial backoff delay between webhook retries in milliseconds",
      ),
    maxPayloadBytes: z
      .number({ error: "ingress.webhook.maxPayloadBytes must be a number" })
      .int("ingress.webhook.maxPayloadBytes must be an integer")
      .positive("ingress.webhook.maxPayloadBytes must be a positive integer")
      .default(1_048_576)
      .describe("Maximum allowed webhook payload size in bytes"),
  })
  .describe("Webhook configuration for ingress event delivery");

export const IngressRateLimitConfigSchema = z
  .object({
    maxRequestsPerMinute: z
      .number({
        error: "ingress.rateLimit.maxRequestsPerMinute must be a number",
      })
      .int("ingress.rateLimit.maxRequestsPerMinute must be an integer")
      .nonnegative(
        "ingress.rateLimit.maxRequestsPerMinute must be a non-negative integer",
      )
      .default(0)
      .describe(
        "Maximum number of ingress requests allowed per minute (0 = unlimited)",
      ),
    maxRequestsPerHour: z
      .number({
        error: "ingress.rateLimit.maxRequestsPerHour must be a number",
      })
      .int("ingress.rateLimit.maxRequestsPerHour must be an integer")
      .nonnegative(
        "ingress.rateLimit.maxRequestsPerHour must be a non-negative integer",
      )
      .default(0)
      .describe(
        "Maximum number of ingress requests allowed per hour (0 = unlimited)",
      ),
  })
  .describe("Rate limiting for ingress requests");

const IngressBaseSchema = z
  .object({
    enabled: z
      .boolean({ error: "ingress.enabled must be a boolean" })
      .optional()
      .describe("Whether the ingress HTTP server is enabled"),
    publicBaseUrl: z
      .string({ error: "ingress.publicBaseUrl must be a string" })
      .refine(
        (val) => val === "" || /^https?:\/\//i.test(val),
        "ingress.publicBaseUrl must be an absolute URL starting with http:// or https://",
      )
      .default("")
      .describe(
        "Public-facing base URL for the ingress server (used in webhook callbacks)",
      ),
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
      .default(5_000)
      .describe(
        "Time in milliseconds to drain in-flight requests during graceful shutdown",
      ),
  })
  .describe(
    "Ingress HTTP server configuration — handles incoming webhooks, API requests, and channel events",
  );

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
