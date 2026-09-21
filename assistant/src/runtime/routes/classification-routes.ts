/**
 * Transport-agnostic route definitions for the classification family.
 *
 * GET /v1/classification/providers: catalog of classification providers
 *   plus whether the configured one currently resolves.
 */

import { z } from "zod";

import { listClassificationProviderEntries } from "../../providers/classification/provider-catalog.js";
import { resolveClassificationAvailability } from "../../providers/classification/resolve.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

async function handleListProviders() {
  const providers = listClassificationProviderEntries().map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    subtitle: entry.subtitle,
    setupMode: entry.setupMode,
    setupHint: entry.setupHint,
    apiKeyProviderName: entry.credentialProvider,
    defaultModel: entry.defaultModel,
    models: entry.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
    })),
    supportsManaged: entry.managedProxyPath !== undefined,
    credentialsGuide: entry.credentialsGuide,
  }));
  const availability = await resolveClassificationAvailability();
  return { providers, availability };
}

const CredentialsGuideSchema = z.object({
  description: z.string(),
  url: z.string(),
  linkLabel: z.string(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "classification_providers",
    endpoint: "classification/providers",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List classification providers",
    description:
      "Return the catalog of classification (decision-model) providers with client-facing metadata, and whether the configured provider currently resolves.",
    tags: ["classification"],
    responseBody: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          subtitle: z.string(),
          setupMode: z.string(),
          setupHint: z.string(),
          apiKeyProviderName: z.string(),
          defaultModel: z.string(),
          models: z.array(
            z.object({ id: z.string(), displayName: z.string() }),
          ),
          supportsManaged: z.boolean(),
          credentialsGuide: CredentialsGuideSchema,
        }),
      ),
      availability: z.object({
        available: z.boolean(),
        mode: z.enum(["managed", "your-own"]),
        providerId: z.string(),
        model: z.string(),
        source: z.enum(["user-key", "managed-proxy"]).optional(),
        reason: z
          .enum([
            "unknown_provider",
            "missing_credential",
            "managed_unsupported",
            "platform_unavailable",
          ])
          .optional(),
      }),
    }),
    handler: handleListProviders,
  },
];
