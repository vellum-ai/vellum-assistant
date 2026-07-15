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
 * POST   /v1/credentials/delete  — delete a credential, metadata, and OAuth
 * GET    /v1/credentials/status  — show active credential backend info
 */

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import {
  fetchManagedCatalog,
  type ManagedCredentialDescriptor,
} from "../../credential-execution/managed-catalog.js";
import { buildForChatSentinel } from "../../daemon/chat-credential-redaction.js";
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
import { recordForChatMint } from "../for-chat-mint-registry.js";
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

  const forChat = (body as { forChat?: unknown }).forChat === true;
  if (
    forChat &&
    !isAssistantFeatureFlagEnabled("chat-credential-reveal", getConfig())
  ) {
    throw new BadRequestError(
      "--for-chat requires the chat-credential-reveal feature flag",
    );
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

  // Recording gate shared by both registries below: only a DIRECT tool-shell
  // CLI invocation may create authority. The `local` principal is the
  // identity a CLI invocation arrives with over the unix-socket IPC
  // (verified by the adapters, never caller-supplied), but the principal
  // check alone is not enough: in local mode the gateway derives `local`
  // from the verified JWT sub and forwards it for web calls too, stamping
  // `x-vellum-proxy-server: ipc` — a header a direct CLI never sends — so
  // proxied Settings-row/chat-chip reveals are excluded.
  const directLocalInvocation =
    headers?.["x-vellum-principal-type"] === "local" &&
    headers?.["x-vellum-proxy-server"] !== "ipc";

  if (forChat) {
    // Both lookup forms resolve service+field (or throw); the narrow check
    // keeps the sentinel's vault coordinates provably non-empty.
    if (!lookup.service || !lookup.field) {
      throw new BadRequestError(
        "Credential identity could not be resolved for --for-chat",
      );
    }
    // Chat-safe reveal: return the enriched redaction sentinel instead of
    // the plaintext. The caller (the model, echoing a tool result) can
    // paste this into its reply to render a click-to-reveal chip without
    // the secret ever entering model context or the conversation stream.
    // The persist-path forgery guard re-mints it on identity match — see
    // guardForChatSentinels in chat-credential-redaction.ts. No plaintext
    // reaches the tool, so no reveal-success proof is recorded: that
    // registry authorizes plaintext-echo swaps, and retaining the secret
    // for a path that never emits it would widen retention for nothing.
    const sentinel = buildForChatSentinel({
      service: lookup.service,
      field: lookup.field,
      value: secret,
    });
    // Record the mint AFTER the reveal provably succeeded. This registry —
    // not any parse of the requested shell command — is what authorizes the
    // persist guard to re-mint a sentinel with this identity: a command
    // that merely quotes or comments out a reveal invocation never reaches
    // this route, so it never allowlists anything. Like the plaintext proof
    // below, the mint records only for a direct tool-shell invocation. No
    // conversation identity is read from the request — anything the caller
    // could send here (body field, env-forwarded id) is caller-controlled;
    // conversation scoping happens at the CONSUMER against the run's own
    // staged reveal identities (see the registry module doc).
    if (directLocalInvocation) {
      recordForChatMint({
        service: lookup.service,
        field: lookup.field,
        sentinel,
      });
    }
    return { value: sentinel };
  }

  // Ground truth for the chat-credential-reveal persist seams: this route
  // is the only place a reveal legitimately reads plaintext, so a success
  // recorded here is the proof the agent loop requires before promoting
  // staged reveal candidates (a shell command can "succeed" without ever
  // reaching this handler — `… || true`, or an echo of the command text).
  // Recording a proxied UI reveal would let a click promote a staged ref
  // in a concurrent turn whose command merely echoed (or was denied) the
  // invocation. An unproven ref degrades to a plain sentinel — the safe
  // direction. Both lookup branches populate service/field; the guard only
  // satisfies the loose `CredentialLookup` type.
  if (
    directLocalInvocation &&
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
      "Return the raw plaintext value of a stored credential. Blocked in untrusted shell mode. With forChat, returns a chat-safe redaction sentinel instead of the plaintext.",
    tags: ["credentials"],
    requestBody: z.object({
      service: z.string().optional().describe("Service namespace"),
      field: z.string().optional().describe("Field name"),
      id: z.string().optional().describe("Credential UUID for lookup by ID"),
      forChat: z
        .boolean()
        .optional()
        .describe(
          "Return the credential's redaction sentinel (renders as a click-to-reveal chip in chat) instead of the plaintext. Requires the chat-credential-reveal feature flag.",
        ),
    }),
    responseBody: z.object({
      value: z
        .string()
        .describe(
          "The plaintext credential value (or its redaction sentinel when forChat is set)",
        ),
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
