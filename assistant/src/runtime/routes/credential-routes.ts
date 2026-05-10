/**
 * Transport-agnostic routes for credential management.
 *
 * Exposes list, inspect, reveal, set, delete, and status operations over IPC.
 * All logic that previously lived in the CLI is moved here so the CLI becomes
 * a thin IPC wrapper with no daemon-internal imports.
 */

import { z } from "zod";

import { fetchManagedCatalog } from "../../credential-execution/managed-catalog.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import {
  disconnectOAuthProvider,
  getConnectionByProvider,
  listConnections,
  type OAuthConnectionRow,
} from "../../oauth/oauth-store.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getActiveBackendInfoAsync,
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
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Scrub a secret value for display. Shows `****` + last 4 characters for
 * secrets longer than 4 chars, `****` for secrets 4 chars or fewer, and
 * `(not set)` when no secret is stored.
 */
function scrubSecret(secret: string | undefined): string {
  if (secret == null || secret.length === 0) return "(not set)";
  if (secret.length <= 4) return "****";
  return "****" + secret.slice(-4);
}

/**
 * Build a structured credential output object suitable for both `inspect`
 * and `list` responses.
 */
function buildCredentialOutput(
  metadata: CredentialMetadata,
  secret: string | undefined,
  connection?: OAuthConnectionRow,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    ok: true,
    source: "local",
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

// ---------------------------------------------------------------------------
// Handler: credential_list
// ---------------------------------------------------------------------------

async function handleCredentialList({ queryParams }: RouteHandlerArgs) {
  let allMetadata = listCredentialMetadata();

  if (queryParams?.search) {
    const query = queryParams.search.toLowerCase();
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

  // Build lookup of most recent active connection per provider.
  let allConnections: OAuthConnectionRow[] = [];
  try {
    allConnections = listConnections();
  } catch {
    // Best-effort — oauth tables may not exist yet
  }
  const connectionsByProvider = new Map<string, OAuthConnectionRow>();
  for (const conn of allConnections) {
    if (conn.status !== "active") continue;
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

  // Platform-managed credentials — best-effort
  let managedCredentials: Record<string, unknown>[] = [];
  try {
    const managedResult = await fetchManagedCatalog();
    if (managedResult.ok && managedResult.descriptors.length > 0) {
      let descriptors = managedResult.descriptors;
      if (queryParams?.search) {
        const query = queryParams.search.toLowerCase();
        descriptors = descriptors.filter(
          (d) =>
            d.provider.toLowerCase().includes(query) ||
            d.handle.toLowerCase().includes(query) ||
            (d.accountInfo ?? "").toLowerCase().includes(query),
        );
      }
      managedCredentials = descriptors.map((d) => ({
        ok: true,
        source: "platform",
        handle: d.handle,
        provider: d.provider,
        connectionId: d.connectionId,
        accountInfo: d.accountInfo,
        grantedScopes: d.grantedScopes,
        status: d.status,
      }));
    }
  } catch {
    // Best-effort — catalog fetch may fail when platform is unreachable
  }

  return { ok: true, credentials, managedCredentials };
}

// ---------------------------------------------------------------------------
// Handler: credential_inspect
// ---------------------------------------------------------------------------

async function handleCredentialInspect({ queryParams }: RouteHandlerArgs) {
  const { service, field, id } = queryParams ?? {};

  let metadata: CredentialMetadata | undefined;
  let storageKey: string;
  let resolvedService: string | undefined;
  let resolvedField: string | undefined;

  if (service && field) {
    resolvedService = service;
    resolvedField = field;
    metadata = getCredentialMetadata(service, field);
    storageKey = credentialKey(service, field);
  } else if (id) {
    metadata = getCredentialMetadataById(id);
    if (!metadata) {
      throw new NotFoundError("Credential not found");
    }
    storageKey = credentialKey(metadata.service, metadata.field);
    resolvedService = metadata.service;
    resolvedField = metadata.field;
  } else {
    throw new BadRequestError(
      "Provide service+field or id",
    );
  }

  const { value: secret, unreachable } =
    await getSecureKeyResultAsync(storageKey);

  if (!metadata && (secret == null || secret.length === 0)) {
    if (unreachable) {
      throw new InternalError("Credential store unreachable");
    }
    throw new NotFoundError("Credential not found");
  }

  // If we have a secret but no metadata, return minimal output
  if (!metadata) {
    return {
      ok: true,
      service: resolvedService,
      field: resolvedField,
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

  let connection: OAuthConnectionRow | undefined;
  try {
    connection = getConnectionByProvider(metadata.service);
  } catch {
    connection = undefined;
  }

  const output = buildCredentialOutput(metadata, secret, connection);

  if (unreachable && (secret == null || secret.length === 0)) {
    output.scrubbedValue = "(credential store unreachable)";
    output.brokerUnreachable = true;
    output.unreachable = true;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Handler: credential_reveal
// ---------------------------------------------------------------------------

async function handleCredentialReveal({ queryParams }: RouteHandlerArgs) {
  const { service, field, id } = queryParams ?? {};

  let storageKey: string;

  if (service && field) {
    storageKey = credentialKey(service, field);
  } else if (id) {
    const metadata = getCredentialMetadataById(id);
    if (!metadata) {
      throw new NotFoundError("Credential not found");
    }
    storageKey = credentialKey(metadata.service, metadata.field);
  } else {
    throw new BadRequestError("Provide service+field or id");
  }

  const { value: secret, unreachable } =
    await getSecureKeyResultAsync(storageKey);

  if (secret == null || secret.length === 0) {
    if (unreachable) {
      throw new InternalError("Credential store unreachable");
    }
    throw new NotFoundError("Credential not found");
  }

  return { ok: true, value: secret };
}

// ---------------------------------------------------------------------------
// Handler: credential_set
// ---------------------------------------------------------------------------

const CredentialSetSchema = z.object({
  service: z.string(),
  field: z.string(),
  value: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

async function handleCredentialSet({ body = {} }: RouteHandlerArgs) {
  let parsed: z.infer<typeof CredentialSetSchema>;
  try {
    parsed = CredentialSetSchema.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(message);
  }

  const { service, field, value, label, description, allowedTools } = parsed;

  assertMetadataWritable();

  const stored = await setSecureKeyAsync(credentialKey(service, field), value);
  if (!stored) {
    throw new InternalError("Credential backend write failed");
  }

  const metadata = upsertCredentialMetadata(service, field, {
    alias: label,
    usageDescription: description,
    allowedTools,
  });

  await syncManualTokenConnection(service);

  return { ok: true, credentialId: metadata.credentialId, service, field };
}

// ---------------------------------------------------------------------------
// Handler: credential_delete
// ---------------------------------------------------------------------------

const CredentialDeleteSchema = z.object({
  service: z.string(),
  field: z.string(),
});

async function handleCredentialDelete({ body = {} }: RouteHandlerArgs) {
  let parsed: z.infer<typeof CredentialDeleteSchema>;
  try {
    parsed = CredentialDeleteSchema.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(message);
  }

  const { service, field } = parsed;

  assertMetadataWritable();

  try {
    await deleteSecureKeyAsync(credentialKey(service, field));
  } catch {
    // Best-effort — key may not exist
  }

  deleteCredentialMetadata(service, field);

  try {
    await disconnectOAuthProvider(service);
  } catch {
    // Best-effort — OAuth tables may not exist yet
  }

  return { ok: true, service, field };
}

// ---------------------------------------------------------------------------
// Handler: credential_status
// ---------------------------------------------------------------------------

async function handleCredentialStatus(_args: RouteHandlerArgs) {
  const info = await getActiveBackendInfoAsync();
  return { ok: true, ...info };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const CREDENTIAL_ROUTES: RouteDefinition[] = [
  {
    operationId: "credential_list",
    endpoint: "credentials",
    method: "GET",
    handler: handleCredentialList,
    summary: "List all stored credentials",
    description:
      "Returns local credentials and platform-managed credentials. Supports optional search filtering.",
    tags: ["credentials"],
    queryParams: [
      {
        name: "search",
        type: "string",
        required: false,
        description:
          "Filter credentials by case-insensitive substring match on service, field, label, or description",
      },
    ],
  },
  {
    operationId: "credential_inspect",
    endpoint: "credentials/inspect",
    method: "GET",
    handler: handleCredentialInspect,
    summary: "Inspect a credential",
    description:
      "Show metadata and a masked preview of a stored credential. Look up by service+field or by credential UUID.",
    tags: ["credentials"],
    queryParams: [
      { name: "service", type: "string", required: false },
      { name: "field", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },
  {
    operationId: "credential_reveal",
    endpoint: "credentials/reveal",
    method: "GET",
    handler: handleCredentialReveal,
    summary: "Reveal a credential's plaintext value",
    description:
      "Returns the raw secret value. IPC socket is Unix-domain (local only); plaintext access is safe.",
    tags: ["credentials"],
    queryParams: [
      { name: "service", type: "string", required: false },
      { name: "field", type: "string", required: false },
      { name: "id", type: "string", required: false },
    ],
  },
  {
    operationId: "credential_set",
    endpoint: "credentials",
    method: "POST",
    handler: handleCredentialSet,
    summary: "Store or update a credential",
    description:
      "Stores a secret value and creates or updates associated metadata.",
    tags: ["credentials"],
    requestBody: CredentialSetSchema,
    responseBody: z.object({
      ok: z.boolean(),
      credentialId: z.string(),
      service: z.string(),
      field: z.string(),
    }),
  },
  {
    operationId: "credential_delete",
    endpoint: "credentials/delete",
    method: "POST",
    handler: handleCredentialDelete,
    summary: "Delete a credential",
    description:
      "Removes the encrypted secret, its metadata, and any associated OAuth connection. Uses POST to carry body params cleanly over IPC.",
    tags: ["credentials"],
    requestBody: CredentialDeleteSchema,
    responseBody: z.object({
      ok: z.boolean(),
      service: z.string(),
      field: z.string(),
    }),
  },
  {
    operationId: "credential_status",
    endpoint: "credentials/status",
    method: "GET",
    handler: handleCredentialStatus,
    summary: "Show credential backend status",
    description:
      "Returns the active credential storage backend and its configuration details.",
    tags: ["credentials"],
  },
];
