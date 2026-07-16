/**
 * Route definitions for inference provider connection CRUD.
 *
 * GET    /v1/inference/provider-connections          — list all connections (optional ?provider= filter)
 * GET    /v1/inference/provider-connections/:name    — single connection by name
 * POST   /v1/inference/provider-connections          — create a new connection
 * PATCH  /v1/inference/provider-connections/:name    — update auth/label (cannot rename or change provider; auth is locked to platform for managed connections)
 * DELETE /v1/inference/provider-connections/:name    — delete (rejects if profiles or call sites reference it; rejects outright for managed connections)
 */

import { z } from "zod";

import { getEffectiveProfiles } from "../../config/default-profile-catalog.js";
import {
  getDefaultProviderFromConfig,
  resolveDefaultConnectionName,
} from "../../config/default-provider-resolution.js";
import { getIsPlatform } from "../../config/env-registry.js";
import { getConfigReadOnly } from "../../config/loader.js";
import { getDb } from "../../persistence/db-connection.js";
import {
  type Auth,
  AuthSchema,
  type ConnectionModel,
  ConnectionModelSchema,
  ConnectionProviderSchema,
  deriveAuthForProvider,
  ProviderConnectionSchema,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
  VALID_CONNECTION_PROVIDERS,
} from "../../providers/inference/auth.js";
import {
  createConnection,
  deleteConnection,
  getConnection,
  LEGACY_MANAGED_CONNECTION_NAMES,
  listConnections,
  MANAGED_CONNECTION_NAMES,
  updateConnection,
} from "../../providers/inference/connections.js";
import {
  isPrivateOrLocalHost,
  resolveHostAddresses,
  resolveRequestAddress,
} from "../../tools/network/url-safety.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Shared Zod schema for the ProviderConnection response shape
// ---------------------------------------------------------------------------

const providerConnectionResponseSchema = ProviderConnectionSchema;

// ---------------------------------------------------------------------------
// Custom provider field parsing (openai-compatible base_url + models)
// ---------------------------------------------------------------------------

/**
 * Parse and validate `base_url` and `models` from the request body.
 *
 * `base_url` is only accepted for providers in
 * `PROVIDERS_REQUIRING_BASE_URL_AND_MODELS` (currently `openai-compatible`).
 * For all other providers, supplying `base_url` returns a 400. This prevents
 * API-key exfiltration: an attacker cannot create an `anthropic` connection
 * with a `base_url` pointing to their own server, which would redirect all
 * LLM calls (and the API key) to the attacker.
 *
 * Even for `openai-compatible`, the `base_url` must not point to private
 * networks or cloud metadata endpoints (SSRF protection).
 */
async function parseCustomProviderFields(
  body: Record<string, unknown>,
  provider: string,
): Promise<{
  baseUrl?: string | null;
  models?: ConnectionModel[] | null;
}> {
  const out: {
    baseUrl?: string | null;
    models?: ConnectionModel[] | null;
  } = {};

  if ("base_url" in body) {
    const raw = body.base_url;

    // Gate: base_url is only valid for openai-compatible providers.
    if (
      raw !== null &&
      raw !== undefined &&
      !PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)
    ) {
      throw new BadRequestError(
        `base_url is only valid for openai-compatible providers. Remove base_url or use the openai-compatible provider type.`,
      );
    }

    if (raw === null) {
      out.baseUrl = null;
    } else if (typeof raw === "string" && raw.length > 0) {
      let parsed: URL;
      try {
        parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new BadRequestError(`Invalid base_url: must be an http(s) URL`);
        }
      } catch (err) {
        if (err instanceof BadRequestError) {
          throw err;
        }
        throw new BadRequestError(
          `Invalid base_url: must be a valid http(s) URL`,
        );
      }

      // SSRF protection: reject private IPs, localhost, cloud metadata
      // endpoints — but only for platform-hosted daemons where the container
      // runs on Vellum infrastructure. Self-hosted daemons run on the user's
      // own machine, so localhost/private addresses are the expected target
      // (e.g. LM Studio, vLLM, text-generation-webui).
      if (getIsPlatform()) {
        const hostname = parsed.hostname;
        if (isPrivateOrLocalHost(hostname)) {
          throw new BadRequestError(
            `Invalid base_url: must not point to a private or local network address.`,
          );
        }

        const resolved = await resolveRequestAddress(
          hostname,
          resolveHostAddresses,
          /* allowPrivateNetwork */ false,
        );
        if (resolved.blockedAddress) {
          throw new BadRequestError(
            `Invalid base_url: hostname resolves to a private network address.`,
          );
        }
      }

      out.baseUrl = raw;
    } else {
      throw new BadRequestError(
        `Invalid base_url: must be a non-empty string or null`,
      );
    }
  }

  if ("models" in body) {
    const raw = body.models;
    if (raw === null) {
      out.models = null;
    } else {
      const parsed = z.array(ConnectionModelSchema).safeParse(raw);
      if (!parsed.success) {
        throw new BadRequestError(`Invalid models: ${parsed.error.message}`);
      }
      out.models = parsed.data;
    }
  }

  return out;
}

/**
 * Derive the auth object for a body that omits `auth`, from the provider and
 * the optional top-level `credential` field. Throws the 400s for the cases
 * the derivation can't express: a malformed credential, or a provider that
 * needs an API key when none was supplied.
 */
function deriveConnectionAuth(provider: string, credential: unknown): Auth {
  if (
    credential !== undefined &&
    (typeof credential !== "string" || credential.length === 0)
  ) {
    throw new BadRequestError("credential must be a non-empty string");
  }
  const derived = deriveAuthForProvider(provider, credential);
  if (!derived) {
    throw new BadRequestError(
      `Provider "${provider}" requires an API key. Pass "credential" (a vault credential key) or an explicit "auth" object.`,
    );
  }
  return derived;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListConnections({ queryParams = {} }: RouteHandlerArgs) {
  const provider = queryParams.provider;
  const connections = listConnections(
    getDb(),
    provider ? { provider } : undefined,
  ).filter((c) => !LEGACY_MANAGED_CONNECTION_NAMES.has(c.name));
  return { connections };
}

function handleGetConnection({ pathParams = {} }: RouteHandlerArgs) {
  const { name } = pathParams;
  if (!name) {
    throw new BadRequestError("name is required");
  }

  const conn = getConnection(getDb(), name);
  if (!conn) {
    throw new NotFoundError(`Connection "${name}" not found.`);
  }

  return conn;
}

async function handleCreateConnection({ body = {} }: RouteHandlerArgs) {
  const name = body.name;
  const provider = body.provider;
  const auth = body.auth;

  if (typeof name !== "string" || !name) {
    throw new BadRequestError("name must be a non-empty string");
  }

  const providerResult = ConnectionProviderSchema.safeParse(provider);
  if (!providerResult.success) {
    throw new BadRequestError(
      `Invalid provider "${String(provider)}". Valid: ${VALID_CONNECTION_PROVIDERS.join(", ")}`,
    );
  }
  const authResult = AuthSchema.safeParse(
    auth ?? deriveConnectionAuth(providerResult.data, body.credential),
  );
  if (!authResult.success) {
    throw new BadRequestError(`Invalid auth: ${authResult.error.message}`);
  }

  const labelRaw = body.label;
  if (
    labelRaw !== undefined &&
    labelRaw !== null &&
    (typeof labelRaw !== "string" || labelRaw.length === 0)
  ) {
    throw new BadRequestError(
      `Invalid label: must be a non-empty string or null`,
    );
  }

  const customFields = await parseCustomProviderFields(
    body,
    providerResult.data,
  );

  const result = createConnection(getDb(), {
    name,
    provider: providerResult.data,
    auth: authResult.data,
    ...(labelRaw !== undefined ? { label: labelRaw as string | null } : {}),
    ...customFields,
  });

  if (!result.ok) {
    if (result.error.code === "already_exists") {
      throw new ConflictError(
        `Connection "${name}" already exists. Use PATCH to update it.`,
      );
    }
    if (result.error.code === "invalid_provider") {
      throw new BadRequestError(
        `Invalid provider "${result.error.provider}". Valid: ${VALID_CONNECTION_PROVIDERS.join(", ")}`,
      );
    }
    if (result.error.code === "base_url_required") {
      throw new BadRequestError(
        "base_url is required for openai-compatible providers.",
      );
    }
    if (result.error.code === "models_required") {
      throw new BadRequestError(
        "At least one model is required for openai-compatible providers.",
      );
    }
    throw new BadRequestError("Invalid auth configuration.");
  }

  return result.connection;
}

async function handleUpdateConnection({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const { name } = pathParams;
  if (!name) {
    throw new BadRequestError("name is required");
  }

  const existing = getConnection(getDb(), name);
  if (!existing) {
    throw new NotFoundError(`Connection "${name}" not found.`);
  }

  // `auth` is optional: an explicit object wins; a bare `credential` rotates
  // the key by re-deriving from the provider; omitting both leaves the stored
  // auth untouched (so label-only edits never disturb e.g. an
  // oauth_subscription connection).
  if (
    body.auth === undefined &&
    body.credential !== undefined &&
    existing.auth.type === "oauth_subscription"
  ) {
    // Derivation would silently flip the auth type to api_key. Rotating a
    // subscription token goes through the ChatGPT sign-in routes; switching
    // to key auth requires an explicit `auth` object.
    throw new BadRequestError(
      `Connection "${name}" uses subscription auth, which "credential" cannot rotate. Re-run the ChatGPT sign-in flow, or pass an explicit "auth" object to switch auth types.`,
    );
  }
  const auth =
    body.auth ??
    (body.credential !== undefined
      ? deriveConnectionAuth(existing.provider, body.credential)
      : existing.auth);
  const authResult = AuthSchema.safeParse(auth);
  if (!authResult.success) {
    throw new BadRequestError(`Invalid auth: ${authResult.error.message}`);
  }

  const labelRaw = body.label;
  if (
    labelRaw !== undefined &&
    labelRaw !== null &&
    (typeof labelRaw !== "string" || labelRaw.length === 0)
  ) {
    throw new BadRequestError(
      `Invalid label: must be a non-empty string or null`,
    );
  }

  // Managed connections: lock auth to `{type:"platform"}`. The boot upsert in
  // `seedCanonicalConnections` would revert any other value on next restart;
  // reject the write here so the surprise loop never happens. Label remains
  // user-editable (the boot upsert leaves it alone).
  if (
    MANAGED_CONNECTION_NAMES.has(name) &&
    authResult.data.type !== "platform"
  ) {
    throw new BadRequestError(
      `Cannot change auth on managed connection "${name}". Auth is locked to platform.`,
    );
  }

  const customFields = await parseCustomProviderFields(body, existing.provider);

  const result = updateConnection(getDb(), name, {
    auth: authResult.data,
    ...(labelRaw !== undefined ? { label: labelRaw as string | null } : {}),
    ...customFields,
  });

  if (!result.ok) {
    if (result.error.code === "not_found") {
      throw new NotFoundError(`Connection "${name}" not found.`);
    }
    if (result.error.code === "base_url_required") {
      throw new BadRequestError(
        "base_url is required for openai-compatible providers.",
      );
    }
    if (result.error.code === "models_required") {
      throw new BadRequestError(
        "At least one model is required for openai-compatible providers.",
      );
    }
    throw new BadRequestError("Invalid auth configuration.");
  }

  return result.connection;
}

function handleDeleteConnection({ pathParams = {} }: RouteHandlerArgs) {
  const { name } = pathParams;
  if (!name) {
    throw new BadRequestError("name is required");
  }

  // Existence check first so a stale profile `provider_connection`
  // reference to a missing connection returns 404 (not 409).
  const existing = getConnection(getDb(), name);
  if (!existing) {
    throw new NotFoundError(`Connection "${name}" not found.`);
  }

  // Managed connections are write-protected: `seedCanonicalConnections` would
  // re-upsert them on the next daemon boot anyway, so a successful delete here
  // produces a confusing delete → reappear loop. Reject outright. Mirrors
  // `rejectManagedProfileDeletion` for managed profiles (which are similarly
  // re-overlaid by `seed-inference-profiles.ts` on boot).
  if (MANAGED_CONNECTION_NAMES.has(name)) {
    throw new BadRequestError(
      `Cannot delete managed connection "${name}". This is a Vellum-managed connection that is re-seeded on every startup.`,
    );
  }

  const config = getConfigReadOnly();

  // llm.defaultProvider: guards both the resolved connection name (explicit
  // `connectionName` or the `<provider>-personal` convention) and the case
  // where the convention name is dangling but this is the last remaining
  // connection for the default's provider — resolution treats a dangling
  // default as an explainable error; this guard keeps UI deletes from
  // orphaning it silently. The last-connection fallback only applies to
  // convention resolution: an explicit `connectionName` pins exactly one row
  // (protected above), so unrelated same-provider rows stay deletable. Legacy
  // managed rows are excluded from the count for the same reason the list
  // route hides them — they aren't user-manageable connections.
  const dp = getDefaultProviderFromConfig(config);
  if (dp) {
    if (name === resolveDefaultConnectionName(dp)) {
      throw new ConflictError(
        `Connection "${name}" is referenced by llm.defaultProvider. Update llm.defaultProvider before deleting.`,
        { referencedBy: ["llm.defaultProvider"] },
      );
    }
    if (
      !dp.connectionName &&
      existing.provider === dp.provider &&
      listConnections(getDb(), { provider: dp.provider }).filter(
        (c) => !LEGACY_MANAGED_CONNECTION_NAMES.has(c.name),
      ).length === 1
    ) {
      throw new ConflictError(
        `Connection "${name}" is the only connection for provider "${dp.provider}", which llm.defaultProvider depends on. Update llm.defaultProvider or add another connection for provider "${dp.provider}" before deleting.`,
        { referencedBy: ["llm.defaultProvider"] },
      );
    }
  }

  // llm.profiles.*: only ProfileEntry has provider_connection.
  const profiles = getEffectiveProfiles(config.llm?.profiles);
  const referencingProfiles = Object.entries(profiles)
    .filter(
      ([, p]) => (p as Record<string, unknown>).provider_connection === name,
    )
    .map(([profileName]) => profileName);

  const result = deleteConnection(getDb(), name, {
    referencingProfiles,
  });

  if (!result.ok) {
    if (result.error.code === "not_found") {
      throw new NotFoundError(`Connection "${name}" not found.`);
    }
    if (result.error.code === "has_references") {
      throw new ConflictError(
        `Connection "${name}" is referenced by ${result.error.count} profile(s): ${referencingProfiles.join(", ")}.`,
        { referencedBy: referencingProfiles },
      );
    }
    throw new BadRequestError("Delete failed.");
  }

  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_provider_connections_list",
    endpoint: "inference/provider-connections",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List provider connections",
    description:
      "Return all provider connections. Optionally filter by provider with ?provider=<name>.",
    tags: ["inference"],
    queryParams: [
      {
        name: "provider",
        schema: { type: "string" },
        description: `Filter by provider. One of: ${VALID_CONNECTION_PROVIDERS.join(", ")}`,
      },
    ],
    responseBody: z.object({
      connections: z.array(providerConnectionResponseSchema),
    }),
    handler: handleListConnections,
  },
  {
    operationId: "inference_provider_connections_get",
    endpoint: "inference/provider-connections/:name",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a provider connection",
    description: "Return a single provider connection by name.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Connection name" }],
    responseBody: providerConnectionResponseSchema,
    additionalResponses: { "404": { description: "Connection not found" } },
    handler: handleGetConnection,
  },
  {
    operationId: "inference_provider_connections_create",
    endpoint: "inference/provider-connections",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a provider connection",
    description:
      "Create a new named provider connection. When auth is omitted it is derived from the provider (keyless providers get none, vellum gets platform, everything else needs credential for api_key auth). Fails with 409 if a connection with this name already exists.",
    tags: ["inference"],
    requestBody: z.object({
      name: z.string().min(1),
      provider: ConnectionProviderSchema,
      auth: AuthSchema.optional(),
      credential: z.string().min(1).optional(),
      label: z.string().min(1).optional(),
      base_url: z.string().url().nullable().optional(),
      models: z.array(ConnectionModelSchema).nullable().optional(),
    }),
    responseBody: providerConnectionResponseSchema,
    responseStatus: "201",
    additionalResponses: {
      "400": { description: "Invalid provider or auth schema" },
      "409": { description: "Connection name already exists" },
    },
    handler: handleCreateConnection,
  },
  {
    operationId: "inference_provider_connections_update",
    endpoint: "inference/provider-connections/:name",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a provider connection",
    description:
      "Update an existing connection. Cannot rename or change the provider. Omitting auth keeps the stored auth; passing credential alone rotates the key via provider-derived api_key auth. For the Vellum-managed connection (vellum) the auth is locked to platform; label remains editable.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Connection name" }],
    requestBody: z.object({
      auth: AuthSchema.optional(),
      credential: z.string().min(1).optional(),
      label: z.string().min(1).nullable().optional(),
      base_url: z.string().url().nullable().optional(),
      models: z.array(ConnectionModelSchema).nullable().optional(),
    }),
    responseBody: providerConnectionResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "Invalid auth schema, or attempt to change auth on a managed connection",
      },
      "404": { description: "Connection not found" },
    },
    handler: handleUpdateConnection,
  },
  {
    operationId: "inference_provider_connections_delete",
    endpoint: "inference/provider-connections/:name",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a provider connection",
    description:
      "Delete a provider connection. Fails with 400 for the Vellum-managed connection (vellum) which is re-seeded on boot. Fails with 409 if any profile or call-site references the connection.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Connection name" }],
    responseBody: z.object({ ok: z.literal(true) }),
    additionalResponses: {
      "400": {
        description:
          "Connection is a Vellum-managed connection and cannot be deleted",
      },
      "404": { description: "Connection not found" },
      "409": {
        description: "Connection is referenced by profile(s) or call site(s)",
      },
    },
    handler: handleDeleteConnection,
  },
];
