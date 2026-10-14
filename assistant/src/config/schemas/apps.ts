import { z } from "zod";

/** Identifiers of the publish providers the daemon ships with. */
export const PUBLISH_PROVIDER_IDS = ["vercel", "webhook"] as const;

export type PublishProviderId = (typeof PUBLISH_PROVIDER_IDS)[number];

export const PublishWebhookConfigSchema = z
  .object({
    url: z
      .string({ error: "apps.publish.webhook.url must be a string" })
      .catch("")
      .default("")
      .describe(
        "HTTP(S) endpoint the webhook publish provider POSTs the compiled app to. Empty means the provider is unconfigured.",
      ),
    unpublishUrl: z
      .string({ error: "apps.publish.webhook.unpublishUrl must be a string" })
      .catch("")
      .default("")
      .describe(
        "HTTP(S) endpoint used to take a deployment down. Empty falls back to apps.publish.webhook.url.",
      ),
    unpublishMethod: z
      .enum(["DELETE", "POST"])
      .catch("DELETE")
      .default("DELETE")
      .describe("HTTP method used for the unpublish request"),
    timeoutMs: z
      .number({ error: "apps.publish.webhook.timeoutMs must be a number" })
      .int("apps.publish.webhook.timeoutMs must be an integer")
      .min(1_000, "apps.publish.webhook.timeoutMs must be >= 1000")
      .max(600_000, "apps.publish.webhook.timeoutMs must be <= 600000")
      .catch(60_000)
      .default(60_000)
      .describe("Deadline for a single webhook publish or unpublish request"),
  })
  .describe(
    "Generic HTTP publish target. The bearer token is read from the credential store (publish_webhook/token), never from this block.",
  );

export type PublishWebhookConfig = z.infer<typeof PublishWebhookConfigSchema>;

export const AppsPublishConfigSchema = z
  .object({
    // `.catch` keeps an unknown provider id (a typo, or one written by a newer
    // build) from failing the whole config load: publishing falls back to the
    // shipped default instead.
    provider: z
      .enum(PUBLISH_PROVIDER_IDS)
      .default("vercel")
      .catch("vercel")
      .describe("Which publish provider deploys an app's compiled HTML"),
    webhook: PublishWebhookConfigSchema.default(
      PublishWebhookConfigSchema.parse({}),
    ),
  })
  .describe("App publishing configuration");

export type AppsPublishConfig = z.infer<typeof AppsPublishConfigSchema>;

export const AppsConfigSchema = z
  .object({
    publish: AppsPublishConfigSchema.default(AppsPublishConfigSchema.parse({})),
  })
  .describe("Assistant-built app configuration");

export type AppsConfig = z.infer<typeof AppsConfigSchema>;
