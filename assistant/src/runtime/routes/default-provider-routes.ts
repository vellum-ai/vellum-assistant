/**
 * Route handlers for the workspace default provider (`llm.defaultProvider`).
 *
 * GET /v1/config/llm/default-provider — current value + availability status
 * PUT /v1/config/llm/default-provider — replace the value (strict-validated)
 *
 * The dedicated PUT exists because the generic config write paths parse
 * `llm.defaultProvider` through `.catch(undefined)` — an invalid value is
 * silently dropped on the next reparse instead of rejected. This route
 * strict-parses and fails loudly.
 *
 * Availability is reported, never enforced: a dangling connection name is a
 * valid persisted state by design (see `DefaultProviderSchema`), and the GET
 * names what is broken and how to fix it.
 */
import { z } from "zod";

import { setDefaultProvider } from "../../config/default-provider.js";
import {
  getDefaultProviderFromConfig,
  resolveDefaultConnectionName,
} from "../../config/default-provider-resolution.js";
import { getConfigReadOnly } from "../../config/loader.js";
import {
  DEFAULT_PROVIDER_CHOICES,
  DefaultProviderSchema,
} from "../../config/schemas/llm.js";
import { ROUTING_IDENTITY_PROVIDERS } from "../../providers/inference/auth.js";
import {
  computeConnectionAvailability,
  CONNECTION_AVAILABILITY_STATUSES,
} from "../../providers/inference/connection-availability.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const availabilitySchema = z.object({
  // `missing_default` is this route's own verdict (no default provider is
  // configured at all), so it extends the shared set rather than living in it.
  status: z.enum([...CONNECTION_AVAILABILITY_STATUSES, "missing_default"]),
  /** Present on every non-`ok` status: names the broken thing and the fix. */
  message: z.string().optional(),
});

const defaultProviderStatusSchema = z
  .object({
    provider: z
      .enum(DEFAULT_PROVIDER_CHOICES as [string, ...string[]])
      .nullable(),
    /** Explicit connection pin, when the persisted value carries one. */
    connectionName: z.string().optional(),
    /** The connection the default resolves to (explicit pin or convention). */
    resolvedConnectionName: z.string().nullable(),
    availability: availabilitySchema,
  })
  .meta({ id: "DefaultProviderStatus" });

type DefaultProviderStatus = z.infer<typeof defaultProviderStatusSchema>;

const SETTINGS_HINT = "in Settings → Models & Services";

async function handleGetDefaultProvider(): Promise<DefaultProviderStatus> {
  const dp = getDefaultProviderFromConfig(getConfigReadOnly());
  if (!dp) {
    return {
      provider: null,
      resolvedConnectionName: null,
      availability: {
        status: "missing_default",
        message: `No default provider is configured. Pick one ${SETTINGS_HINT}.`,
      },
    };
  }
  const resolvedConnectionName = resolveDefaultConnectionName(dp);
  return {
    provider: dp.provider,
    ...(dp.connectionName ? { connectionName: dp.connectionName } : {}),
    resolvedConnectionName,
    availability: await computeConnectionAvailability(
      dp.provider,
      resolvedConnectionName,
    ),
  };
}

async function handlePutDefaultProvider({
  body = {},
}: RouteHandlerArgs): Promise<DefaultProviderStatus> {
  const result = DefaultProviderSchema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError(
      `Invalid default provider. "provider" must be one of: ${DEFAULT_PROVIDER_CHOICES.join(
        ", ",
      )}; "connectionName" is optional and must be a non-empty string.`,
    );
  }
  // Routing identities dispatch through their canonical row regardless of
  // any stored pin (`resolveRoutingIdentity`), so a noncanonical
  // connectionName would be judged by availability and the deletion guards
  // while inference uses a different row. Reject it here rather than
  // persisting a pin that status and dispatch disagree about.
  const { provider, connectionName } = result.data;
  if (connectionName != null && ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    const canonical = resolveDefaultConnectionName({ provider });
    if (connectionName !== canonical) {
      throw new BadRequestError(
        `Provider "${provider}" always dispatches through its canonical connection "${canonical}". Omit "connectionName" or pass "${canonical}".`,
      );
    }
  }
  setDefaultProvider(result.data);
  return handleGetDefaultProvider();
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "llm_default_provider_get",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "config/llm/default-provider",
    handler: handleGetDefaultProvider,
    summary: "Get the default provider and its availability",
    description:
      "Returns `llm.defaultProvider`, the connection name it resolves to, and whether that connection is currently usable (connection exists, credential stored, Vellum authenticated). Availability is informational — a broken default is a valid persisted state that surfaces explainable errors at resolution time.",
    tags: ["config"],
    responseBody: defaultProviderStatusSchema,
  },
  {
    operationId: "llm_default_provider_put",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "config/llm/default-provider",
    handler: handlePutDefaultProvider,
    summary: "Set the default provider",
    description:
      "Replaces `llm.defaultProvider`. Strict-validates the body (unlike the generic config write paths, which silently drop invalid values). Does not require the referenced connection to exist — a dangling name is allowed by design and reported via the availability status.",
    tags: ["config"],
    requestBody: DefaultProviderSchema,
    responseBody: defaultProviderStatusSchema,
  },
];
