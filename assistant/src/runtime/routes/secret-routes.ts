/**
 * Route definitions for secret and credential management.
 *
 * POST   /v1/secrets      — add a secret (API key or credential)
 * DELETE /v1/secrets      — delete a secret
 * GET    /v1/secrets      — list all stored secrets
 * POST   /v1/secrets/read — read (masked or revealed) a secret value
 */

import { z } from "zod";

import {
  getPlatformAssistantId,
  setPlatformAssistantId,
  setPlatformBaseUrl,
  setPlatformOrganizationId,
  setPlatformUserId,
} from "../../config/env.js";
import {
  API_KEY_PROVIDERS,
  getConfig,
  invalidateConfigCache,
} from "../../config/loader.js";
import type { CesClient } from "../../credential-execution/client.js";
import { setSentryOrganizationId, setSentryUserId } from "../../instrument.js";
import { clearEmbeddingBackendCache } from "../../memory/embedding-backend.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import { validateAnthropicApiKey } from "../../providers/anthropic/client.js";
import { validateGeminiApiKey } from "../../providers/gemini/client.js";
import { validateOpenAIApiKey } from "../../providers/openai/client.js";
import { initializeProviders } from "../../providers/registry.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getActiveBackendName,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  listSecureKeysAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import { getSecretsDeps } from "./secrets-deps.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("runtime-http");
const MANAGED_PROXY_CREDENTIALS = [
  { service: "vellum", field: "assistant_api_key" },
  { service: "vellum", field: "platform_base_url" },
] as const;

function isManagedProxyCredential(service: string, field: string): boolean {
  return MANAGED_PROXY_CREDENTIALS.some(
    (c) => c.service === service && c.field === field,
  );
}

const CES_READY_POLL_INTERVAL_MS = 500;
const CES_READY_POLL_TIMEOUT_MS = 30_000;

let apiKeyGeneration = 0;

async function queueApiKeyPropagation(
  cesClient: CesClient,
  apiKey: string,
  generation: number,
): Promise<void> {
  log.info(
    "CES client not ready — queuing API key propagation until handshake completes",
  );
  const deadline = Date.now() + CES_READY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CES_READY_POLL_INTERVAL_MS));
    if (generation < apiKeyGeneration) {
      log.info(
        "Discarding stale queued API key propagation — a newer key was already handled",
      );
      return;
    }
    if (cesClient.isReady()) {
      if (generation < apiKeyGeneration) {
        log.info(
          "Discarding stale queued API key propagation — a newer key was already handled",
        );
        return;
      }
      try {
        await cesClient.updateAssistantApiKey(
          apiKey,
          getPlatformAssistantId() || undefined,
        );
        log.info(
          "Pushed queued assistant API key to CES after handshake completed",
        );
      } catch (err) {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "Failed to push queued assistant API key to CES (non-fatal)",
        );
      }
      return;
    }
  }
  log.warn(
    "Timed out waiting for CES client to become ready — API key was not propagated",
  );
}

// ---------------------------------------------------------------------------
// Provider refresh after secret changes
// ---------------------------------------------------------------------------

async function refreshProvidersAfterSecretChange(): Promise<void> {
  clearEmbeddingBackendCache();
  invalidateConfigCache();
  await initializeProviders(getConfig());

  const deps = getSecretsDeps();
  if (!deps?.onProviderCredentialsChanged) return;

  try {
    await deps.onProviderCredentialsChanged();
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Error notifying provider credentials change (non-fatal)",
    );
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleAddSecret({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { type, name, value } = body as {
    type?: string;
    name?: string;
    value?: string;
  };

  if (!type || typeof type !== "string") {
    throw new BadRequestError("type is required");
  }
  if (!name || typeof name !== "string") {
    throw new BadRequestError("name is required");
  }
  if (!value || typeof value !== "string") {
    throw new BadRequestError("value is required");
  }

  try {
    if (type === "api_key") {
      if (
        !API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])
      ) {
        throw new BadRequestError(
          `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(", ")}`,
        );
      }

      if (name === "anthropic") {
        const validation = await validateAnthropicApiKey(value);
        if (!validation.valid) {
          log.warn(
            { provider: name, reason: validation.reason },
            "API key validation failed",
          );
          return { success: false, error: validation.reason };
        }
      } else if (name === "openai") {
        const validation = await validateOpenAIApiKey(value);
        if (!validation.valid) {
          log.warn(
            { provider: name, reason: validation.reason },
            "API key validation failed",
          );
          return { success: false, error: validation.reason };
        }
      } else if (name === "gemini") {
        const validation = await validateGeminiApiKey(value);
        if (!validation.valid) {
          log.warn(
            { provider: name, reason: validation.reason },
            "API key validation failed",
          );
          return { success: false, error: validation.reason };
        }
      }

      const stored = await setSecureKeyAsync(name, value);
      if (!stored) {
        throw new InternalError(
          `Failed to store API key in secure storage (backend: ${getActiveBackendName()})`,
        );
      }
      await refreshProvidersAfterSecretChange();
      log.info({ provider: name }, "API key updated via HTTP");
      return { success: true, type, name };
    }

    if (type === "credential") {
      const colonIdx = name.lastIndexOf(":");
      if (colonIdx < 1 || colonIdx === name.length - 1) {
        throw new BadRequestError(
          'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
        );
      }
      assertMetadataWritable();
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      const key = credentialKey(service, field);

      const TRIMMED_IDENTITY_FIELDS = new Set([
        "platform_assistant_id",
        "platform_organization_id",
        "platform_user_id",
      ]);
      const isTrimmedIdentity =
        service === "vellum" && TRIMMED_IDENTITY_FIELDS.has(field);
      const effectiveValue = isTrimmedIdentity ? value.trim() : value;

      if (isTrimmedIdentity && effectiveValue === "") {
        const deleteResult = await deleteSecureKeyAsync(key);
        if (deleteResult === "error") {
          throw new InternalError(
            `Failed to delete stale credential from secure storage: ${service}:${field}`,
          );
        }
        if (field === "platform_assistant_id") {
          setPlatformAssistantId(undefined);
        } else if (field === "platform_organization_id") {
          setPlatformOrganizationId(undefined);
          setSentryOrganizationId(undefined);
        } else if (field === "platform_user_id") {
          setPlatformUserId(undefined);
          setSentryUserId(undefined);
        }
        deleteCredentialMetadata(service, field);
      } else {
        const stored = await setSecureKeyAsync(key, effectiveValue);
        if (!stored) {
          throw new InternalError(
            `Failed to store credential in secure storage (backend: ${getActiveBackendName()})`,
          );
        }
        upsertCredentialMetadata(service, field, {});
        await syncManualTokenConnection(service);
        if (service === "vellum" && field === "platform_base_url") {
          setPlatformBaseUrl(effectiveValue);
        }
        if (service === "vellum" && field === "platform_assistant_id") {
          setPlatformAssistantId(effectiveValue || undefined);
        }
        if (service === "vellum" && field === "platform_organization_id") {
          setPlatformOrganizationId(effectiveValue || undefined);
          setSentryOrganizationId(effectiveValue || undefined);
        }
        if (service === "vellum" && field === "platform_user_id") {
          setPlatformUserId(effectiveValue || undefined);
          setSentryUserId(effectiveValue || undefined);
        }
      }
      if (isManagedProxyCredential(service, field)) {
        await refreshProvidersAfterSecretChange();
        if (service === "vellum" && field === "assistant_api_key") {
          const generation = ++apiKeyGeneration;
          const deps = getSecretsDeps();
          const cesClient = deps?.getCesClient?.();
          if (cesClient) {
            if (cesClient.isReady()) {
              try {
                await cesClient.updateAssistantApiKey(
                  value,
                  getPlatformAssistantId() || undefined,
                );
                log.info(
                  "Pushed assistant API key to CES after managed proxy credential update",
                );
              } catch (err) {
                log.warn(
                  { error: err instanceof Error ? err.message : String(err) },
                  "Failed to push assistant API key to CES (non-fatal)",
                );
              }
            } else {
              void queueApiKeyPropagation(cesClient, value, generation);
            }
          }
        }
      }
      log.info({ service, field }, "Credential added via HTTP");
      return { success: true, type, name };
    }

    throw new BadRequestError(
      `Unknown secret type: ${type}. Valid types: api_key, credential`,
    );
  } catch (err) {
    if (
      err instanceof BadRequestError ||
      err instanceof InternalError ||
      err instanceof NotFoundError
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, type, name }, "Failed to add secret via HTTP");
    throw new InternalError(message);
  }
}

async function handleReadSecret({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { type, name, reveal } = body as {
    type?: string;
    name?: string;
    reveal?: boolean;
  };

  if (!type || typeof type !== "string") {
    throw new BadRequestError("type is required");
  }
  if (!name || typeof name !== "string") {
    throw new BadRequestError("name is required");
  }

  try {
    let accountKey: string;

    if (type === "api_key") {
      if (
        !API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])
      ) {
        throw new BadRequestError(
          `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(", ")}`,
        );
      }
      accountKey = name;
    } else if (type === "credential") {
      const colonIdx = name.lastIndexOf(":");
      if (colonIdx < 1 || colonIdx === name.length - 1) {
        throw new BadRequestError(
          'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
        );
      }
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      accountKey = credentialKey(service, field);
    } else {
      throw new BadRequestError(
        `Unknown secret type: ${type}. Valid types: api_key, credential`,
      );
    }

    const { value, unreachable } = await getSecureKeyResultAsync(accountKey);
    if (value === undefined) {
      return { found: false, unreachable };
    }

    if (reveal) {
      return { found: true, value, unreachable: false };
    }

    const minHidden = 3;
    const maxVisible = Math.max(1, value.length - minHidden);
    const prefixLen = Math.min(10, maxVisible);
    const suffixLen = Math.min(4, Math.max(0, maxVisible - prefixLen));
    const masked = `${value.slice(0, prefixLen)}...${suffixLen > 0 ? value.slice(-suffixLen) : ""}`;

    return { found: true, masked, unreachable: false };
  } catch (err) {
    if (
      err instanceof BadRequestError ||
      err instanceof InternalError ||
      err instanceof NotFoundError
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, type, name }, "Failed to read secret via HTTP");
    throw new InternalError(message);
  }
}

async function handleDeleteSecret({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { type, name } = body as { type?: string; name?: string };

  if (!type || typeof type !== "string") {
    throw new BadRequestError("type is required");
  }
  if (!name || typeof name !== "string") {
    throw new BadRequestError("name is required");
  }

  try {
    if (type === "api_key") {
      if (
        !API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])
      ) {
        throw new BadRequestError(
          `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(", ")}`,
        );
      }
      const existing = await getSecureKeyAsync(name);
      if (existing === undefined) {
        throw new NotFoundError(`API key not found: ${name}`);
      }
      const deleteResult = await deleteSecureKeyAsync(name);
      if (deleteResult === "error") {
        throw new InternalError(
          `Failed to delete API key from secure storage: ${name}`,
        );
      }
      await refreshProvidersAfterSecretChange();
      log.info({ provider: name }, "API key deleted via HTTP");
      return { success: true, type, name };
    }

    if (type === "credential") {
      const colonIdx = name.lastIndexOf(":");
      if (colonIdx < 1 || colonIdx === name.length - 1) {
        throw new BadRequestError(
          'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
        );
      }
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      assertMetadataWritable();
      const key = credentialKey(service, field);
      const existing = await getSecureKeyAsync(key);
      if (existing === undefined) {
        throw new NotFoundError(`Credential not found: ${name}`);
      }
      const deleteResult = await deleteSecureKeyAsync(key);
      if (deleteResult === "error") {
        throw new InternalError(
          `Failed to delete credential from secure storage: ${name}`,
        );
      }
      deleteCredentialMetadata(service, field);
      if (service === "vellum" && field === "platform_base_url") {
        setPlatformBaseUrl(undefined);
      }
      if (service === "vellum" && field === "platform_assistant_id") {
        setPlatformAssistantId(undefined);
      }
      if (service === "vellum" && field === "platform_organization_id") {
        setPlatformOrganizationId(undefined);
        setSentryOrganizationId(undefined);
      }
      if (service === "vellum" && field === "platform_user_id") {
        setPlatformUserId(undefined);
        setSentryUserId(undefined);
      }
      if (isManagedProxyCredential(service, field)) {
        await refreshProvidersAfterSecretChange();
      }
      log.info({ service, field }, "Credential deleted via HTTP");
      return { success: true, type, name };
    }

    throw new BadRequestError(
      `Unknown secret type: ${type}. Valid types: api_key, credential`,
    );
  } catch (err) {
    if (
      err instanceof BadRequestError ||
      err instanceof InternalError ||
      err instanceof NotFoundError
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, type, name }, "Failed to delete secret via HTTP");
    throw new InternalError(message);
  }
}

const CREDENTIAL_KEY_PREFIX = "credential/";

async function handleListSecrets() {
  try {
    const { accounts, unreachable } = await listSecureKeysAsync();
    if (unreachable) {
      throw new InternalError("Credential store is unreachable");
    }

    const secrets = accounts.map((account) => {
      if (account.startsWith(CREDENTIAL_KEY_PREFIX)) {
        const rest = account.slice(CREDENTIAL_KEY_PREFIX.length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx > 0 && slashIdx < rest.length - 1) {
          return {
            type: "credential" as const,
            name: `${rest.slice(0, slashIdx)}:${rest.slice(slashIdx + 1)}`,
          };
        }
      }
      return { type: "api_key" as const, name: account };
    });

    return { secrets, accounts: secrets };
  } catch (err) {
    if (
      err instanceof BadRequestError ||
      err instanceof InternalError ||
      err instanceof NotFoundError
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(message);
  }
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "secrets_add",
    endpoint: "secrets",
    method: "POST",
    policyKey: "secrets",
    summary: "Add a secret",
    description:
      "Store a new secret (API key, OAuth token, etc.) in the credential vault.",
    tags: ["secrets"],
    requestBody: z.object({
      type: z.string().describe("Secret type: 'api_key' or 'credential'"),
      name: z.string().describe("Unique name for the secret"),
      value: z.string().describe("Secret value to store"),
    }),
    responseBody: z.object({
      success: z.boolean(),
      type: z.string(),
      name: z.string(),
    }),
    handler: handleAddSecret,
  },
  {
    operationId: "secrets_delete",
    endpoint: "secrets",
    method: "DELETE",
    policyKey: "secrets",
    summary: "Delete a secret",
    description: "Remove a secret from the credential vault by name.",
    tags: ["secrets"],
    requestBody: z.object({
      type: z.string().describe("Secret type: 'api_key' or 'credential'"),
      name: z.string().describe("Name of the secret to delete"),
    }),
    responseBody: z.object({
      success: z.boolean(),
      type: z.string(),
      name: z.string(),
    }),
    handler: handleDeleteSecret,
  },
  {
    operationId: "secrets_list",
    endpoint: "secrets",
    method: "GET",
    policyKey: "secrets",
    summary: "List secrets",
    description: "Return the names (not values) of all stored secrets.",
    tags: ["secrets"],
    responseBody: z.object({
      secrets: z
        .array(z.unknown())
        .describe("List of secret metadata entries, each with type and name"),
      accounts: z.array(z.unknown()).describe("Alias for secrets (same data)"),
    }),
    handler: handleListSecrets,
  },
  {
    operationId: "secrets_read",
    endpoint: "secrets/read",
    method: "POST",
    policyKey: "secrets",
    summary: "Read a secret value",
    description: "Retrieve the decrypted value of a stored secret by name.",
    tags: ["secrets"],
    requestBody: z.object({
      type: z.string().describe("Secret type: 'api_key' or 'credential'"),
      name: z.string().describe("Name of the secret to read"),
      reveal: z
        .boolean()
        .describe(
          "If true, return the decrypted value; otherwise return a masked version",
        )
        .optional(),
    }),
    responseBody: z.object({
      found: z.boolean(),
      value: z
        .string()
        .describe("Decrypted value (only when reveal=true and found)"),
      masked: z.string().describe("Masked value (when reveal=false and found)"),
      unreachable: z.boolean(),
    }),
    handler: handleReadSecret,
  },
];
