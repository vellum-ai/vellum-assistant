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

import { DEFAULT_PROFILE_PROVIDERS } from "../../config/default-profile-names.js";
import { setDefaultProvider } from "../../config/default-provider.js";
import {
  getDefaultProviderFromConfig,
  resolveDefaultConnectionName,
} from "../../config/default-provider-resolution.js";
import { getConfigReadOnly } from "../../config/loader.js";
import type { DefaultProviderConfig } from "../../config/schemas/llm.js";
import { DefaultProviderSchema } from "../../config/schemas/llm.js";
import { getDb } from "../../persistence/db-connection.js";
import { getConnection } from "../../providers/inference/connections.js";
import { resolveManagedProxyContext } from "../../providers/platform-proxy/context.js";
import { getSecureKeyResultAsync } from "../../security/secure-keys.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const availabilitySchema = z.object({
  status: z.enum([
    "ok",
    "missing_default",
    "missing_connection",
    "missing_credential",
    "unsupported_auth",
    "vellum_unauthenticated",
    "unknown",
  ]),
  /** Present on every non-`ok` status: names the broken thing and the fix. */
  message: z.string().optional(),
});

const defaultProviderStatusSchema = z
  .object({
    provider: z.enum(DEFAULT_PROFILE_PROVIDERS).nullable(),
    /** Explicit connection pin, when the persisted value carries one. */
    connectionName: z.string().optional(),
    /** The connection the default resolves to (explicit pin or convention). */
    resolvedConnectionName: z.string().nullable(),
    availability: availabilitySchema,
  })
  .meta({ id: "DefaultProviderStatus" });

type DefaultProviderStatus = z.infer<typeof defaultProviderStatusSchema>;
type Availability = z.infer<typeof availabilitySchema>;

const SETTINGS_HINT = "in Settings → Models & Services";

async function vellumAvailability(): Promise<Availability> {
  const ctx = await resolveManagedProxyContext();
  if (ctx.enabled) {
    return { status: "ok" };
  }
  return {
    status: "vellum_unauthenticated",
    message: ctx.platformBaseUrl
      ? "Not signed in to Vellum — no assistant API key is stored. Log in to use Vellum-managed inference."
      : "Not signed in to Vellum — the platform URL is not configured.",
  };
}

async function computeAvailability(
  dp: DefaultProviderConfig,
  resolvedConnectionName: string,
): Promise<Availability> {
  if (dp.provider === "vellum") {
    return vellumAvailability();
  }

  let connection;
  try {
    connection = getConnection(getDb(), resolvedConnectionName);
  } catch {
    return {
      status: "unknown",
      message: `Connection "${resolvedConnectionName}" could not be looked up. Try again shortly.`,
    };
  }
  if (!connection) {
    return {
      status: "missing_connection",
      message: `No connection named "${resolvedConnectionName}" exists for provider "${dp.provider}". Add one ${SETTINGS_HINT}.`,
    };
  }

  switch (connection.auth.type) {
    // Schema-accepted but not dispatchable: `resolveAuth` returns
    // not_implemented for service_account, so a stored credential still
    // cannot serve inference.
    case "service_account":
      return {
        status: "unsupported_auth",
        message: `Connection "${resolvedConnectionName}" uses service-account auth, which inference does not support yet. Pick a connection with a different auth type.`,
      };
    case "api_key":
    case "oauth_subscription": {
      const result = await getSecureKeyResultAsync(connection.auth.credential);
      if (result.value != null) {
        return { status: "ok" };
      }
      if (result.unreachable) {
        // Credential store down ≠ credential missing. Reporting
        // `missing_credential` here would send the user re-entering a key
        // that is probably still stored.
        return {
          status: "unknown",
          message: `The credential store is unreachable, so the credential for connection "${resolvedConnectionName}" could not be verified. Try again shortly.`,
        };
      }
      const noun =
        connection.auth.type === "api_key" ? "API key" : "credential";
      return {
        status: "missing_credential",
        message: `Connection "${resolvedConnectionName}" has no ${noun} stored. Add one ${SETTINGS_HINT}.`,
      };
    }
    case "platform":
      return vellumAvailability();
    case "none":
      return { status: "ok" };
  }
}

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
    availability: await computeAvailability(dp, resolvedConnectionName),
  };
}

async function handlePutDefaultProvider({
  body = {},
}: RouteHandlerArgs): Promise<DefaultProviderStatus> {
  const result = DefaultProviderSchema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError(
      `Invalid default provider. "provider" must be one of: ${DEFAULT_PROFILE_PROVIDERS.join(
        ", ",
      )}; "connectionName" is optional and must be a non-empty string.`,
    );
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
