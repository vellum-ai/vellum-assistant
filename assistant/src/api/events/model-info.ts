/**
 * `model_info` SSE event.
 *
 * Server → client snapshot of the active model/provider for a
 * conversation, plus the catalog of configured and available providers
 * and models the client can offer as options.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

const ModelOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

const ProviderCatalogEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  models: z.array(ModelOptionSchema),
  defaultModel: z.string(),
  apiKeyUrl: z.string().optional(),
  apiKeyPlaceholder: z.string().optional(),
});

export const ModelInfoEventSchema = z.object({
  type: z.literal("model_info"),
  conversationId: z.string().optional(),
  model: z.string(),
  provider: z.string(),
  configuredProviders: z.array(z.string()).optional(),
  availableModels: z.array(ModelOptionSchema).optional(),
  allProviders: z.array(ProviderCatalogEntrySchema).optional(),
});

export type ModelInfoEvent = z.infer<typeof ModelInfoEventSchema>;
