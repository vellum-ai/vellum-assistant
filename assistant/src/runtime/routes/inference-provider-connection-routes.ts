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

import { getEffectiveProfilesForProvider } from "../../config/default-profile-catalog.js";
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
  CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
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
import { PROVIDER_CATALOG } from "../../providers/model-catalog.js";
import {
  isVellumManagedConnection,
  VELLUM_MANAGED_PROVIDER,
} from "../../providers/vellum-model-routing.js";
import { credentialKey } from "../../security/credential-key.js";
import { deleteSecureKeyAsync } from "../../security/secure-keys.js";
import {
  isPrivateOrLocalHost,
  resolveHostAddresses,
  resolveRequestAddress,
} from "../../tools/network/url-safety.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("routes/inference-provider-connections");

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

/**
 * Platform auth and `provider: "vellum"` record the same fact (the managed
 * route) in two columns, and derivation always sets them together. Only an
 * explicit `auth` object can split them, producing a row dispatch bills to
 * the platform while every provider-keyed check reads it as BYOK, or the
 * reverse.
 */
function assertAuthMatchesProvider(provider: string, auth: Auth): void {
  const managedAuth = auth.type === "platform";
  const managedProvider = provider === VELLUM_MANAGED_PROVIDER;
  if (managedAuth !== managedProvider) {
    throw new BadRequestError(
      managedAuth
        ? `Auth type "platform" is only valid for provider "${VELLUM_MANAGED_PROVIDER}", not "${provider}". Vellum-managed routing is selected by the provider, so omit "auth" to derive it.`
        : `Provider "${VELLUM_MANAGED_PROVIDER}" is always platform-authenticated; "${auth.type}" auth is not valid for it. Omit "auth" to derive it, or name a real provider for key-based auth.`,
    );
  }
  // Same rule for the subscription identity: provider "chatgpt" and
  // oauth_subscription auth record one fact and must pair, or a key-auth
  // row under the identity would dispatch against the API while the user
  // believes they are on subscription billing.
  const subscriptionAuth = auth.type === "oauth_subscription";
  const subscriptionProvider = provider === "chatgpt";
  if (subscriptionAuth !== subscriptionProvider) {
    throw new BadRequestError(
      subscriptionAuth
        ? `Auth type "oauth_subscription" is only valid for provider "chatgpt", not "${provider}". Run the ChatGPT sign-in flow to connect a subscription.`
        : `Provider "chatgpt" is always subscription-authenticated; "${auth.type}" auth is not valid for it. Run the ChatGPT sign-in flow, or name a real provider for key-based auth.`,
    );
  }
}

/**
 * Stable form of an auth object for equality checks. Auth values are flat, so
 * sorting the entries is enough to make two encodings of the same auth
 * compare equal regardless of key order.
 */
function authFingerprint(auth: Auth): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(auth).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
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

/**
 * Custom providers share the flat provider list with built-ins, so their
 * display identity (label, falling back to name) must not collide with a
 * built-in provider's id or display name, nor with another custom
 * provider's identity. Enforced daemon-side: every client (web, CLI, API)
 * goes through these routes.
 */
function assertValidCustomProviderIdentity(
  provider: string,
  labelRaw: unknown,
  selfName: string,
): void {
  if (provider !== "openai-compatible") {
    return;
  }
  // The display identity is the label, falling back to the name — a
  // label-less row named "openai" impersonates a built-in just as well as
  // a labeled one.
  const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
  const identity = label || selfName;
  const lower = identity.toLowerCase();
  if (RESERVED_PROVIDER_IDENTITIES.has(lower)) {
    throw new BadRequestError(
      `Invalid ${label ? "label" : "name"}: "${identity}" belongs to a built-in provider. Pick another name.`,
    );
  }
  const duplicate = listConnections(getDb(), {
    provider: "openai-compatible",
  }).find(
    (c) =>
      c.name !== selfName &&
      (c.label?.trim() || c.name).toLowerCase() === lower,
  );
  if (duplicate) {
    throw new BadRequestError(
      `Invalid ${label ? "label" : "name"}: a custom provider named "${identity}" already exists.`,
    );
  }
}

/** Built-in provider ids, display names, and routing identities, lowercased. */
const RESERVED_PROVIDER_IDENTITIES = new Set<string>([
  ...PROVIDER_CATALOG.flatMap((p) => [
    p.id.toLowerCase(),
    p.displayName.toLowerCase(),
  ]),
  "vellum",
  "chatgpt",
  "chatgpt subscription",
]);

async function handleCreateConnection({ body = {} }: RouteHandlerArgs) {
  const name = body.name;
  const provider = body.provider;
  const auth = body.auth;

  if (typeof name !== "string" || !name) {
    throw new BadRequestError("name must be a non-empty string");
  }

  // Canonical names belong to boot seeding, which skips a name already taken
  // by a user-owned row, leaving the install with no managed connection and a
  // BYOK row that managed routing then ignores. Refuse the name up front.
  if (MANAGED_CONNECTION_NAMES.has(name)) {
    throw new BadRequestError(
      `Connection name "${name}" is reserved for the Vellum-managed connection. Pick another name.`,
    );
  }
  // Provider ids and routing identities are labels in profile config, so an
  // entry under one of those names could never be referenced by name (the
  // label reads as the vendor), and a future catalog addition must never
  // capture an existing user name. Reserve the whole vocabulary.
  if (VALID_CONNECTION_PROVIDERS.includes(name)) {
    throw new BadRequestError(
      `Connection name "${name}" is reserved as a provider id. Pick another name.`,
    );
  }

  const providerResult = ConnectionProviderSchema.safeParse(provider);
  if (!providerResult.success) {
    throw new BadRequestError(
      `Invalid provider "${String(provider)}". Valid: ${VALID_CONNECTION_PROVIDERS.join(", ")}`,
    );
  }
  // The chatgpt identity lives on its canonical row: routing resolves the
  // subscription by that name, so an identity row under any other name can
  // never dispatch.
  if (
    providerResult.data === "chatgpt" &&
    name !== CHATGPT_SUBSCRIPTION_CONNECTION_NAME
  ) {
    throw new BadRequestError(
      `Provider "chatgpt" is reserved for the "${CHATGPT_SUBSCRIPTION_CONNECTION_NAME}" connection. Run the ChatGPT sign-in flow to connect a subscription.`,
    );
  }
  const authResult = AuthSchema.safeParse(
    auth ?? deriveConnectionAuth(providerResult.data, body.credential),
  );
  if (!authResult.success) {
    throw new BadRequestError(`Invalid auth: ${authResult.error.message}`);
  }
  // Asserted on derived auth as well: derivation pairs every provider
  // correctly except the chatgpt identity, whose fallthrough would mint
  // api_key auth from a bare credential.
  assertAuthMatchesProvider(providerResult.data, authResult.data);

  const labelRaw = body.label;
  if (
    labelRaw !== undefined &&
    labelRaw !== null &&
    (typeof labelRaw !== "string" || labelRaw.trim().length === 0)
  ) {
    throw new BadRequestError(
      `Invalid label: must be a non-blank string or null`,
    );
  }

  const customFields = await parseCustomProviderFields(
    body,
    providerResult.data,
  );

  // Same event-loop turn as the write: no await separates this check from
  // createConnection, so concurrent requests cannot both pass it.
  assertValidCustomProviderIdentity(providerResult.data, labelRaw, name);

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
  // The canonical subscription row owns the "chatgpt" identity: writing
  // subscription auth to it stamps the provider with the auth, mirroring
  // the daemon's own sign-in exchange route. The CLI's login-chatgpt PATCHes
  // auth through this route, and without the stamp a row the identity
  // migration deliberately skipped (a claiming row with key auth) would end
  // up as provider "openai" with subscription auth. Provider stays
  // immutable for every other row.
  const chatgptIdentityStamp =
    name === CHATGPT_SUBSCRIPTION_CONNECTION_NAME &&
    authResult.data.type === "oauth_subscription" &&
    existing.provider !== "chatgpt";

  // The pairing is enforced on an actual auth change, not on the field being
  // present: the web editor and the CLI both resend the stored auth on every
  // edit, so a row whose columns already disagree stays relabelable and
  // re-pointable. Judged against the stamped provider when the stamp
  // applies, since that is the pair being written.
  if (
    body.auth !== undefined &&
    authFingerprint(authResult.data) !== authFingerprint(existing.auth)
  ) {
    assertAuthMatchesProvider(
      chatgptIdentityStamp ? "chatgpt" : existing.provider,
      authResult.data,
    );
  }

  const labelRaw = body.label;
  if (
    labelRaw !== undefined &&
    labelRaw !== null &&
    (typeof labelRaw !== "string" || labelRaw.trim().length === 0)
  ) {
    throw new BadRequestError(
      `Invalid label: must be a non-blank string or null`,
    );
  }
  const customFields = await parseCustomProviderFields(body, existing.provider);

  // Only a CHANGED label is validated: keeping a stored label — whatever it
  // is — must never block unrelated edits (key rotation, models).
  // Labels compare trimmed, the same normalization the identity check
  // applies, so a stored padded label resent trimmed is not a change.
  // Checked in the same event-loop turn as the write so concurrent requests
  // cannot both pass.
  const labelChanging =
    labelRaw !== undefined &&
    (typeof labelRaw === "string" ? labelRaw.trim() : "") !==
      (existing.label ?? "").trim();
  if (labelChanging) {
    assertValidCustomProviderIdentity(existing.provider, labelRaw, name);
  }

  const result = updateConnection(getDb(), name, {
    auth: authResult.data,
    ...(chatgptIdentityStamp ? { provider: "chatgpt" } : {}),
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

async function handleDeleteConnection({ pathParams = {} }: RouteHandlerArgs) {
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
  //
  // Gated on the row, not the name: an install predating the reserved name can
  // hold a user-owned row here, which boot seeding refuses to overwrite and
  // managed routing ignores. That row must stay deletable, since deleting it
  // is what lets boot seeding restore the real managed connection.
  const claimsManagedName =
    MANAGED_CONNECTION_NAMES.has(name) && !isVellumManagedConnection(existing);
  if (MANAGED_CONNECTION_NAMES.has(name) && !claimsManagedName) {
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
  // A `vellum` default resolves to the canonical name, so this guard would
  // otherwise block deleting a row that merely claims that name. Deleting it
  // does not orphan the default: boot seeding writes the real managed
  // connection under the same name on the next restart.
  if (dp && !claimsManagedName) {
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

  // llm.profiles.*: only ProfileEntry has provider_connection. Resolved
  // provider-aware so the scan sees the same bodies the runtime resolver
  // produces: on a BYO install the default profiles carry the
  // `provider_connection` they actually dispatch through. Today every name
  // the defaults can stamp is also caught by the `llm.defaultProvider` guard
  // above; this keeps the scan a faithful backstop rather than one that
  // silently skips the defaults.
  const profiles = getEffectiveProfilesForProvider(config.llm?.profiles, dp);
  // A binding lives in `provider` (the entry name) under the entries model,
  // or in the legacy `provider_connection` field; both count, or deleting a
  // bound entry would dangle the profile behind selection's silent healing.
  // Provider values count only for non-vendor names: a profile saying
  // "vellum" references the routing identity, never a row that happens to
  // claim that name, and the claiming-row delete is the recovery path.
  const nameIsEntryName = !VALID_CONNECTION_PROVIDERS.includes(name);
  const referencingProfiles = Object.entries(profiles)
    .filter(([, p]) => {
      const entry = p as Record<string, unknown>;
      return (
        entry.provider_connection === name ||
        (nameIsEntryName && entry.provider === name)
      );
    })
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

  // A per-connection credential slot is owned by exactly this row, so the
  // delete removes it too. Provider-keyed and custom refs stay: they can be
  // shared across rows. Awaited so the response orders after the vault
  // delete — a client that deletes, recreates the name, and saves a new key
  // must never have that key erased by a still-in-flight deletion. Failures
  // are logged, never surfaced: a vault outage leaves an orphaned secret,
  // not a failed delete (the timeout on vault calls bounds the wait).
  if (
    existing.auth.type === "api_key" &&
    existing.auth.credential === credentialKey(name, "api_key")
  ) {
    try {
      await deleteSecureKeyAsync(existing.auth.credential);
    } catch (err) {
      log.warn(
        { err, connection: name, credential: existing.auth.credential },
        "Failed to delete the connection's credential slot — secret orphaned in the vault",
      );
    }
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
      "Create a new named provider connection. When auth is omitted it is derived from the provider (keyless providers get none, vellum gets platform, everything else needs credential for api_key auth). An explicit auth object must agree with the provider; platform auth belongs to vellum and only to vellum. Fails with 409 if a connection with this name already exists.",
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
      "Update an existing connection. Cannot rename or change the provider. Omitting auth keeps the stored auth; passing credential alone rotates the key via provider-derived api_key auth. An explicit auth object must agree with the connection's provider; platform auth belongs to vellum and only to vellum. For the Vellum-managed connection (vellum) the auth is locked to platform; label remains editable.",
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
