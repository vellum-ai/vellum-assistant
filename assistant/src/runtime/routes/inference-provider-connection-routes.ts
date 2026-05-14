/**
 * Route definitions for inference provider connection CRUD.
 *
 * GET    /v1/inference/provider-connections          — list all connections (optional ?provider= filter)
 * GET    /v1/inference/provider-connections/:name    — single connection by name
 * POST   /v1/inference/provider-connections          — create a new connection
 * PATCH  /v1/inference/provider-connections/:name    — update auth/label/status (cannot rename or change provider; auth is locked to platform for managed connections)
 * DELETE /v1/inference/provider-connections/:name    — delete (rejects if profiles or call sites reference it; rejects outright for managed connections)
 */

import { z } from "zod";

import { getConfigReadOnly } from "../../config/loader.js";
import { getDb } from "../../memory/db-connection.js";
import {
  AuthSchema,
  ConnectionProviderSchema,
  ConnectionStatusSchema,
  ProviderConnectionSchema,
  VALID_CONNECTION_PROVIDERS,
} from "../../providers/inference/auth.js";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  MANAGED_CONNECTION_NAMES,
  updateConnection,
} from "../../providers/inference/connections.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Shared Zod schema for the ProviderConnection response shape
// ---------------------------------------------------------------------------

const providerConnectionResponseSchema = ProviderConnectionSchema;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListConnections({ queryParams = {} }: RouteHandlerArgs) {
  const provider = queryParams.provider;
  const connections = listConnections(
    getDb(),
    provider ? { provider } : undefined,
  );
  return { connections };
}

function handleGetConnection({ pathParams = {} }: RouteHandlerArgs) {
  const { name } = pathParams;
  if (!name) throw new BadRequestError("name is required");

  const conn = getConnection(getDb(), name);
  if (!conn) throw new NotFoundError(`Connection "${name}" not found.`);

  return conn;
}

function handleCreateConnection({ body = {} }: RouteHandlerArgs) {
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

  const authResult = AuthSchema.safeParse(auth);
  if (!authResult.success) {
    throw new BadRequestError(`Invalid auth: ${authResult.error.message}`);
  }

  const statusResult =
    body.status !== undefined
      ? ConnectionStatusSchema.safeParse(body.status)
      : null;
  if (statusResult && !statusResult.success) {
    throw new BadRequestError(`Invalid status: must be "active" or "disabled"`);
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

  const result = createConnection(getDb(), {
    name,
    provider: providerResult.data,
    auth: authResult.data,
    ...(statusResult ? { status: statusResult.data } : {}),
    ...(labelRaw !== undefined ? { label: labelRaw as string | null } : {}),
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
    throw new BadRequestError("Invalid auth configuration.");
  }

  return result.connection;
}

function handleUpdateConnection({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const { name } = pathParams;
  if (!name) throw new BadRequestError("name is required");

  const auth = body.auth;
  const authResult = AuthSchema.safeParse(auth);
  if (!authResult.success) {
    throw new BadRequestError(`Invalid auth: ${authResult.error.message}`);
  }

  const statusResult =
    body.status !== undefined
      ? ConnectionStatusSchema.safeParse(body.status)
      : null;
  if (statusResult && !statusResult.success) {
    throw new BadRequestError(`Invalid status: must be "active" or "disabled"`);
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
  // reject the write here so the surprise loop never happens. Label and status
  // remain user-editable (the boot upsert leaves those alone).
  if (
    MANAGED_CONNECTION_NAMES.has(name) &&
    authResult.data.type !== "platform"
  ) {
    throw new BadRequestError(
      `Cannot change auth on managed connection "${name}". Auth is locked to platform.`,
    );
  }

  const result = updateConnection(getDb(), name, {
    auth: authResult.data,
    ...(statusResult ? { status: statusResult.data } : {}),
    ...(labelRaw !== undefined ? { label: labelRaw as string | null } : {}),
  });

  if (!result.ok) {
    if (result.error.code === "not_found") {
      throw new NotFoundError(`Connection "${name}" not found.`);
    }
    throw new BadRequestError("Invalid auth configuration.");
  }

  return result.connection;
}

function handleDeleteConnection({ pathParams = {} }: RouteHandlerArgs) {
  const { name } = pathParams;
  if (!name) throw new BadRequestError("name is required");

  // Existence check first so a stale `llm.default.provider_connection`
  // reference to a missing connection returns 404 (not 409).
  if (!getConnection(getDb(), name)) {
    throw new NotFoundError(`Connection "${name}" not found.`);
  }

  // Managed connections are write-protected: `seedCanonicalConnections` would
  // re-upsert them on the next daemon boot anyway, so a successful delete here
  // produces a confusing delete → reappear loop. Reject outright. Mirrors
  // `rejectManagedProfileDeletion` for managed profiles (which are similarly
  // re-overlaid by `seed-inference-profiles.ts` on boot).
  if (MANAGED_CONNECTION_NAMES.has(name)) {
    throw new BadRequestError(
      `Cannot delete managed connection "${name}". This is a Vellum-managed connection — disable it via PATCH status="disabled" if you want to opt out of platform inference.`,
    );
  }

  const config = getConfigReadOnly();

  // llm.default carries provider_connection (LLMConfigBase).
  if (
    (config.llm?.default as Record<string, unknown> | undefined)
      ?.provider_connection === name
  ) {
    throw new ConflictError(
      `Connection "${name}" is referenced by llm.default. Update llm.default.provider_connection before deleting.`,
      { referencedBy: ["llm.default"] },
    );
  }

  // llm.profiles.*: only ProfileEntry has provider_connection.
  const profiles = config.llm?.profiles ?? {};
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
    policyKey: "inference/provider-connections",
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
    policyKey: "inference/provider-connections/detail",
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
    policyKey: "inference/provider-connections",
    summary: "Create a provider connection",
    description:
      "Create a new named provider connection. Fails with 409 if a connection with this name already exists.",
    tags: ["inference"],
    requestBody: z.object({
      name: z.string().min(1),
      provider: ConnectionProviderSchema,
      auth: AuthSchema,
      label: z.string().min(1).optional(),
      status: ConnectionStatusSchema.optional(),
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
    policyKey: "inference/provider-connections/detail",
    summary: "Update a provider connection",
    description:
      "Update an existing connection. Cannot rename or change the provider. For managed connections (anthropic-managed, openai-managed, gemini-managed) the auth is locked to platform; label and status remain editable.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Connection name" }],
    requestBody: z.object({
      auth: AuthSchema,
      status: ConnectionStatusSchema.optional(),
      label: z.string().min(1).nullable().optional(),
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
    policyKey: "inference/provider-connections/detail",
    summary: "Delete a provider connection",
    description:
      "Delete a provider connection. Fails with 400 for managed connections (anthropic-managed, openai-managed, gemini-managed) which are re-seeded on boot. Fails with 409 if any profile or call-site references the connection.",
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
