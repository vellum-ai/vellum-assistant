/**
 * Transport-agnostic route definitions for credential management CLI operations.
 *
 * These routes provide higher-level credential operations (list with metadata,
 * inspect, reveal, set, delete, status) that compose the lower-level secret
 * storage primitives with metadata, OAuth connections, and platform-managed
 * credential catalogs.
 *
 * POST   /v1/credentials/list    — list all credentials with metadata
 * POST   /v1/credentials/inspect — inspect a single credential (masked)
 * POST   /v1/credentials/reveal  — reveal a credential's plaintext value
 * POST   /v1/credentials/set     — store a credential with metadata
 * POST   /v1/credentials/grant   — grant a tool read access (metadata-only)
 * POST   /v1/credentials/delete  — delete a credential, metadata, and OAuth
 * GET    /v1/credentials/status  — show active credential backend info
 */

import { z } from "zod";

import {
  AcpCredentialFormatError,
  assertAcpCredentialFormat,
} from "../../acp/acp-credentials.js";
import {
  fetchManagedCatalog,
  type ManagedCredentialDescriptor,
} from "../../credential-execution/managed-catalog.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import {
  disconnectOAuthProvider,
  getConnectionByProvider,
  listConnections,
  type OAuthConnectionRow,
} from "../../oauth/oauth-store.js";
import { credentialKey } from "../../security/credential-key.js";
import { normalizeSecretValue } from "../../security/secret-normalize.js";
import {
  deleteSecureKeyAsync,
  getActiveBackendInfoAsync,
  getActiveBackendName,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  type CredentialMetadata,
  deleteCredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../../tools/credentials/policy-types.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { recordRevealSuccess } from "../reveal-success-registry.js";
import { InjectionTemplateSchema } from "./credential-prompt-routes.js";
import { BadRequestError, InternalError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function scrubSecret(secret: string | undefined): string {
  if (secret == null || secret.length === 0) {
    return "(not set)";
  }
  if (secret.length <= 4) {
    return "****";
  }
  return "****" + secret.slice(-4);
}

function safeGetConnectionByProvider(
  service: string,
): OAuthConnectionRow | undefined {
  try {
    return getConnectionByProvider(service);
  } catch {
    return undefined;
  }
}

function safeListConnections(): OAuthConnectionRow[] {
  try {
    return listConnections();
  } catch {
    return [];
  }
}

function buildCredentialOutput(
  metadata: CredentialMetadata,
  secret: string | undefined,
  connection?: OAuthConnectionRow,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    service: metadata.service,
    field: metadata.field,
    credentialId: metadata.credentialId,
    scrubbedValue: scrubSecret(secret),
    hasSecret: secret != null && secret.length > 0,
    alias: metadata.alias ?? null,
    usageDescription: metadata.usageDescription ?? null,
    allowedTools: metadata.allowedTools,
    allowedDomains: metadata.allowedDomains,
    createdAt: new Date(metadata.createdAt).toISOString(),
    updatedAt: new Date(metadata.updatedAt).toISOString(),
    injectionTemplateCount: metadata.injectionTemplates?.length ?? 0,
    grantedScopes: connection ? JSON.parse(connection.grantedScopes) : null,
    expiresAt: connection?.expiresAt
      ? new Date(connection.expiresAt).toISOString()
      : null,
  };

  if (connection) {
    output.oauthConnectionId = connection.id;
    output.oauthAccountInfo = connection.accountInfo ?? null;
    output.oauthStatus = connection.status;
    output.oauthHasRefreshToken = connection.hasRefreshToken === 1;
    output.oauthLabel = connection.label ?? null;
  }

  return output;
}

function buildManagedCredentialOutput(
  descriptor: ManagedCredentialDescriptor,
): Record<string, unknown> {
  return {
    source: "platform",
    handle: descriptor.handle,
    provider: descriptor.provider,
    connectionId: descriptor.connectionId,
    accountInfo: descriptor.accountInfo,
    grantedScopes: descriptor.grantedScopes,
    status: descriptor.status,
  };
}

// ---------------------------------------------------------------------------
// Credential lookup resolution
// ---------------------------------------------------------------------------

interface CredentialLookup {
  storageKey: string;
  metadata: CredentialMetadata | undefined;
  service: string | undefined;
  field: string | undefined;
}

/**
 * Resolve a credential lookup from service+field or UUID.
 * Throws BadRequestError when neither is provided or the UUID is not found.
 */
function resolveCredentialLookup(
  body: Record<string, unknown>,
): CredentialLookup {
  const { service, field, id } = body as {
    service?: string;
    field?: string;
    id?: string;
  };

  if (service && field) {
    return {
      storageKey: credentialKey(service, field),
      metadata: getCredentialMetadata(service, field),
      service,
      field,
    };
  }

  if (id) {
    const metadata = getCredentialMetadataById(id);
    if (!metadata) {
      throw new BadRequestError("Credential not found");
    }
    return {
      storageKey: credentialKey(metadata.service, metadata.field),
      metadata,
      service: metadata.service,
      field: metadata.field,
    };
  }

  throw new BadRequestError("Either service+field or id is required");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCredentialsList({ body }: RouteHandlerArgs) {
  const search = (body as { search?: string } | undefined)?.search;

  let allMetadata = listCredentialMetadata();

  if (search) {
    const query = search.toLowerCase();
    allMetadata = allMetadata.filter((m) => {
      const service = m.service.toLowerCase();
      const field = m.field.toLowerCase();
      const alias = (m.alias ?? "").toLowerCase();
      const description = (m.usageDescription ?? "").toLowerCase();
      return (
        service.includes(query) ||
        field.includes(query) ||
        alias.includes(query) ||
        description.includes(query)
      );
    });
  }

  // Build a lookup of oauth connections keyed by provider for enrichment.
  const allConnections = safeListConnections();
  const connectionsByProvider = new Map<string, OAuthConnectionRow>();
  for (const conn of allConnections) {
    if (conn.status !== "active") {
      continue;
    }
    const existing = connectionsByProvider.get(conn.provider);
    if (!existing || conn.createdAt > existing.createdAt) {
      connectionsByProvider.set(conn.provider, conn);
    }
  }

  const credentials = await Promise.all(
    allMetadata.map(async (m) => {
      const secret = await getSecureKeyAsync(credentialKey(m.service, m.field));
      const connection = connectionsByProvider.get(m.service);
      return buildCredentialOutput(m, secret, connection);
    }),
  );

  // Fetch platform-managed credentials (best-effort).
  const managedResult = await fetchManagedCatalog();
  let managedCredentials: Record<string, unknown>[] = [];
  if (managedResult.ok && managedResult.descriptors.length > 0) {
    let descriptors = managedResult.descriptors;
    if (search) {
      const query = search.toLowerCase();
      descriptors = descriptors.filter(
        (d) =>
          d.provider.toLowerCase().includes(query) ||
          d.handle.toLowerCase().includes(query) ||
          (d.accountInfo ?? "").toLowerCase().includes(query),
      );
    }
    managedCredentials = descriptors.map(buildManagedCredentialOutput);
  }

  return { credentials, managedCredentials };
}

async function handleCredentialsInspect({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const lookup = resolveCredentialLookup(body);
  const { value: secret, unreachable } = await getSecureKeyResultAsync(
    lookup.storageKey,
  );

  if (!lookup.metadata && (secret == null || secret.length === 0)) {
    if (unreachable) {
      throw new InternalError(
        "Credential store is unreachable — ensure the assistant is running",
      );
    }
    throw new BadRequestError("Credential not found");
  }

  // Secret exists but no metadata — build a minimal output.
  if (!lookup.metadata) {
    return {
      service: lookup.service,
      field: lookup.field,
      credentialId: null,
      scrubbedValue: scrubSecret(secret),
      hasSecret: secret != null && secret.length > 0,
      alias: null,
      usageDescription: null,
      allowedTools: [],
      allowedDomains: [],
      createdAt: null,
      updatedAt: null,
      injectionTemplateCount: 0,
    };
  }

  const connection = safeGetConnectionByProvider(lookup.metadata.service);
  const output = buildCredentialOutput(lookup.metadata, secret, connection);

  if (unreachable && (secret == null || secret.length === 0)) {
    output.scrubbedValue = "(credential store unreachable)";
    output.brokerUnreachable = true;
  }

  return output;
}

async function handleCredentialsReveal({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const lookup = resolveCredentialLookup(body);
  const { value: secret, unreachable } = await getSecureKeyResultAsync(
    lookup.storageKey,
  );

  if (secret == null || secret.length === 0) {
    if (unreachable) {
      throw new InternalError(
        "Credential store is unreachable — ensure the assistant is running",
      );
    }
    throw new BadRequestError("Credential not found");
  }

  // Ground truth for the chat-credential-reveal persist seams: this route
  // is the only place a reveal legitimately reads plaintext, so a success
  // recorded here is the proof the agent loop requires before promoting
  // staged reveal candidates (a shell command can "succeed" without ever
  // reaching this handler — `… || true`, or an echo of the command text).
  // Proof is recorded ONLY for the `local` principal on a DIRECT (not
  // gateway-proxied) call — the identity a tool shell's CLI invocation
  // arrives with over the unix-socket IPC (verified by the adapters, never
  // caller-supplied). The principal check alone is not enough: in local
  // mode the gateway derives `local` from the verified JWT sub and
  // forwards it for web calls too, but it always stamps
  // `x-vellum-proxy-server: ipc` — a header a direct CLI never sends — so
  // proxied Settings-row/chat-chip reveals are excluded here. Recording a
  // UI reveal would let a click promote a staged ref in a concurrent turn
  // whose command merely echoed (or was denied) the invocation. An
  // unproven ref degrades to a plain sentinel — the safe direction. Both
  // lookup branches populate service/field; the guard only satisfies the
  // loose `CredentialLookup` type.
  if (
    headers?.["x-vellum-principal-type"] === "local" &&
    headers?.["x-vellum-proxy-server"] !== "ipc" &&
    lookup.service !== undefined &&
    lookup.field !== undefined
  ) {
    recordRevealSuccess(lookup.service, lookup.field, secret);
  }

  return { value: secret };
}

async function handleCredentialsSet({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const {
    service,
    field,
    value,
    label,
    description,
    allowedTools,
    allowedDomains,
    injectionTemplates,
  } = body as {
    service?: string;
    field?: string;
    value?: string;
    label?: string;
    description?: string;
    allowedTools?: string[];
    allowedDomains?: string[];
    injectionTemplates?: CredentialInjectionTemplate[];
  };

  if (!service || typeof service !== "string") {
    throw new BadRequestError("service is required");
  }
  if (!field || typeof field !== "string") {
    throw new BadRequestError("field is required");
  }
  if (!value || typeof value !== "string") {
    throw new BadRequestError("value is required");
  }

  const normalizedValue = normalizeSecretValue(value);
  if (normalizedValue.length === 0) {
    throw new BadRequestError("value is required");
  }

  // Reject a mismatched ACP token type (e.g. an API key in the OAuth field)
  // as a clean 400 that routes the user to the correct field.
  try {
    assertAcpCredentialFormat(service, field, normalizedValue);
  } catch (err) {
    if (err instanceof AcpCredentialFormatError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }

  assertMetadataWritable();

  const key = credentialKey(service, field);
  const stored = await setSecureKeyAsync(key, normalizedValue);
  if (!stored) {
    throw new InternalError(
      `Failed to store credential in secure storage (backend: ${getActiveBackendName()})`,
    );
  }

  const metadata = upsertCredentialMetadata(service, field, {
    alias: label,
    usageDescription: description,
    allowedTools,
    allowedDomains,
    injectionTemplates,
  });
  await syncManualTokenConnection(service);

  return {
    credentialId: metadata.credentialId,
    service,
    field,
  };
}

async function handleCredentialsGrant({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { service, field, tool } = body as {
    service?: string;
    field?: string;
    tool?: string;
  };

  if (!service || typeof service !== "string") {
    throw new BadRequestError("service is required");
  }
  if (!field || typeof field !== "string") {
    throw new BadRequestError("field is required");
  }
  if (!tool || typeof tool !== "string") {
    throw new BadRequestError("tool is required");
  }

  assertMetadataWritable();

  // Metadata-only: merge the tool into allowedTools without reading or
  // rewriting the secret value. Idempotent (a tool already present is a no-op);
  // a credential with no metadata yet gets one created carrying just this tool.
  const existing = getCredentialMetadata(service, field);
  const allowedTools = [...new Set([...(existing?.allowedTools ?? []), tool])];
  const metadata = upsertCredentialMetadata(service, field, { allowedTools });

  return {
    service,
    field,
    allowedTools: metadata.allowedTools,
  };
}

async function handleCredentialsDelete({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { service, field } = body as {
    service?: string;
    field?: string;
  };

  if (!service || typeof service !== "string") {
    throw new BadRequestError("service is required");
  }
  if (!field || typeof field !== "string") {
    throw new BadRequestError("field is required");
  }

  assertMetadataWritable();

  // The Slack user_token only grants read access to channels the bot isn't a
  // member of; Socket Mode itself runs on the bot + app tokens. Deleting just
  // the user_token must leave the oauth_connection intact — disconnecting the
  // provider would flap the integration's connected state until the next sync.
  // Every other step (secret + metadata removal, not-found handling) is the
  // same as a normal credential delete.
  const preserveOAuthConnection =
    service === "slack_channel" && field === "user_token";

  const key = credentialKey(service, field);
  const existing = await getSecureKeyAsync(key);
  const deleteResult =
    existing != null ? await deleteSecureKeyAsync(key) : "not-found";

  if (deleteResult === "error") {
    throw new InternalError(
      `Failed to delete credential from secure storage: ${service}:${field}`,
    );
  }

  const metadataDeleted = deleteCredentialMetadata(service, field);

  // Clean up OAuth connection (best-effort).
  let oauthResult: "disconnected" | "not-found" | "error" = "not-found";
  if (!preserveOAuthConnection) {
    try {
      oauthResult = await disconnectOAuthProvider(service);
    } catch {
      // Best-effort — OAuth tables may not exist yet
    }
  }

  if (oauthResult === "error") {
    throw new InternalError(
      "Failed to disconnect OAuth provider — please try again",
    );
  }

  if (
    deleteResult !== "deleted" &&
    !metadataDeleted &&
    oauthResult !== "disconnected"
  ) {
    throw new BadRequestError("Credential not found");
  }

  return { service, field };
}

async function handleCredentialsStatus() {
  const info = await getActiveBackendInfoAsync();
  return info;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "credentials_list",
    endpoint: "credentials/list",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List all credentials with metadata",
    description:
      "Return all stored credentials with metadata, OAuth connection info, and platform-managed credentials.",
    tags: ["credentials"],
    requestBody: z.object({
      search: z.string().optional().describe("Filter by substring match"),
    }),
    responseBody: z.object({
      credentials: z
        .array(z.unknown())
        .describe("Local credentials with metadata"),
      managedCredentials: z
        .array(z.unknown())
        .describe("Platform-managed credentials"),
    }),
    handler: handleCredentialsList,
  },
  {
    operationId: "credentials_inspect",
    endpoint: "credentials/inspect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Inspect a credential",
    description:
      "Return metadata and a masked preview of a stored credential. Does not reveal the plaintext value.",
    tags: ["credentials"],
    requestBody: z.object({
      service: z.string().optional().describe("Service namespace"),
      field: z.string().optional().describe("Field name"),
      id: z.string().optional().describe("Credential UUID for lookup by ID"),
    }),
    responseBody: z.object({
      service: z.string(),
      field: z.string(),
      credentialId: z.string().nullable(),
      scrubbedValue: z.string(),
      hasSecret: z.boolean(),
    }),
    handler: handleCredentialsInspect,
  },
  {
    operationId: "credentials_reveal",
    endpoint: "credentials/reveal",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Reveal a credential's plaintext value",
    description:
      "Return the raw plaintext value of a stored credential. Blocked in untrusted shell mode.",
    tags: ["credentials"],
    requestBody: z.object({
      service: z.string().optional().describe("Service namespace"),
      field: z.string().optional().describe("Field name"),
      id: z.string().optional().describe("Credential UUID for lookup by ID"),
    }),
    responseBody: z.object({
      value: z.string().describe("The plaintext credential value"),
    }),
    handler: handleCredentialsReveal,
  },
  {
    operationId: "credentials_set",
    endpoint: "credentials/set",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Store a credential with metadata",
    description:
      "Store a secret value and create or update its metadata (label, description, allowed tools).",
    tags: ["credentials"],
    requestBody: z.object({
      service: z.string().describe("Service namespace (e.g. google)"),
      field: z.string().describe("Field name (e.g. client_secret)"),
      value: z.string().describe("Secret value to store"),
      label: z.string().optional().describe("Human-friendly label"),
      description: z
        .string()
        .optional()
        .describe("What this credential is used for"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe("Tool names that may use this credential"),
      allowedDomains: z
        .array(z.string())
        .optional()
        .describe("Domains the credential may be sent to"),
      injectionTemplates: z
        .array(InjectionTemplateSchema)
        .optional()
        .describe("How the credential is injected into requests"),
    }),
    responseBody: z.object({
      credentialId: z.string(),
      service: z.string(),
      field: z.string(),
    }),
    handler: handleCredentialsSet,
  },
  {
    operationId: "credentials_grant",
    endpoint: "credentials/grant",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Grant a tool read access to a credential",
    description:
      "Add a tool name to a credential's allowedTools policy so the broker permits that tool to read it. Metadata-only — never reads or rewrites the secret value.",
    tags: ["credentials"],
    requestBody: z.object({
      service: z.string().describe("Service namespace"),
      field: z.string().describe("Field name"),
      tool: z.string().describe("Tool name to grant read access"),
    }),
    responseBody: z.object({
      service: z.string(),
      field: z.string(),
      allowedTools: z
        .array(z.string())
        .describe("The credential's allowedTools after the grant"),
    }),
    handler: handleCredentialsGrant,
  },
  {
    operationId: "credentials_delete",
    endpoint: "credentials/delete",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a credential",
    description:
      "Remove a secret, its metadata, and any associated OAuth connection from the vault.",
    tags: ["credentials"],
    requestBody: z.object({
      service: z.string().describe("Service namespace"),
      field: z.string().describe("Field name"),
    }),
    responseBody: z.object({
      service: z.string(),
      field: z.string(),
    }),
    handler: handleCredentialsDelete,
  },
  {
    operationId: "credentials_status",
    endpoint: "credentials/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Credential backend status",
    description:
      "Return the active credential storage backend and its configuration details.",
    tags: ["credentials"],
    responseBody: z.object({
      backend: z.string(),
    }),
    handler: handleCredentialsStatus,
  },
];
