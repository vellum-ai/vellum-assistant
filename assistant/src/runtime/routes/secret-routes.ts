import { z } from "zod";

import {
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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

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

/** Monotonic counter that increments each time a new assistant API key is handled.
 *  Queued propagation attempts check this before pushing to avoid overwriting
 *  a newer key with a stale one. */
let apiKeyGeneration = 0;

/**
 * Poll the CES client until it becomes ready, then push the API key —
 * but only if no newer key has been handled in the meantime.
 */
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
        await cesClient.updateAssistantApiKey(apiKey);
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

export async function handleAddSecret(
  req: Request,
  getCesClient?: () => CesClient | undefined,
): Promise<Response> {
  let body: { type?: string; name?: string; value?: string };
  try {
    body = (await req.json()) as {
      type?: string;
      name?: string;
      value?: string;
    };
  } catch {
    return httpError("BAD_REQUEST", "Request body must be valid JSON", 400);
  }

  const { type, name, value } = body;

  if (!type || typeof type !== "string") {
    return httpError("BAD_REQUEST", "type is required", 400);
  }
  if (!name || typeof name !== "string") {
    return httpError("BAD_REQUEST", "name is required", 400);
  }
  if (!value || typeof value !== "string") {
    return httpError("BAD_REQUEST", "value is required", 400);
  }

  try {
    if (type === "api_key") {
      if (
        !API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])
      ) {
        return httpError(
          "BAD_REQUEST",
          `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(
            ", ",
          )}`,
          400,
        );
      }
      // Validate API keys before storing (Anthropic, OpenAI, Gemini)
      if (name === "anthropic") {
        const validation = await validateAnthropicApiKey(value);
        if (!validation.valid) {
          log.warn(
            { provider: name, reason: validation.reason },
            "API key validation failed",
          );
          return Response.json(
            { success: false, error: validation.reason },
            { status: 422 },
          );
        }
      } else if (name === "openai") {
        const validation = await validateOpenAIApiKey(value);
        if (!validation.valid) {
          log.warn(
            { provider: name, reason: validation.reason },
            "API key validation failed",
          );
          return Response.json(
            { success: false, error: validation.reason },
            { status: 422 },
          );
        }
      } else if (name === "gemini") {
        const validation = await validateGeminiApiKey(value);
        if (!validation.valid) {
          log.warn(
            { provider: name, reason: validation.reason },
            "API key validation failed",
          );
          return Response.json(
            { success: false, error: validation.reason },
            { status: 422 },
          );
        }
      }
      // fireworks, openrouter, ollama — no validation (allow storage)

      const stored = await setSecureKeyAsync(name, value);
      if (!stored) {
        return httpError(
          "INTERNAL_ERROR",
          `Failed to store API key in secure storage (backend: ${getActiveBackendName()})`,
          500,
        );
      }
      clearEmbeddingBackendCache();
      invalidateConfigCache();
      await initializeProviders(getConfig());
      log.info({ provider: name }, "API key updated via HTTP");
      return Response.json({ success: true, type, name }, { status: 201 });
    }

    if (type === "credential") {
      const colonIdx = name.lastIndexOf(":");
      if (colonIdx < 1 || colonIdx === name.length - 1) {
        return httpError(
          "BAD_REQUEST",
          'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
          400,
        );
      }
      assertMetadataWritable();
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      const key = credentialKey(service, field);

      // For identity fields, trim whitespace before persisting so the
      // credential store matches the in-memory value.  Whitespace-only
      // input is treated as a no-op: nothing is stored and in-memory
      // state is cleared.
      const TRIMMED_IDENTITY_FIELDS = new Set([
        "platform_assistant_id",
        "platform_organization_id",
        "platform_user_id",
      ]);
      const isTrimmedIdentity =
        service === "vellum" && TRIMMED_IDENTITY_FIELDS.has(field);
      const effectiveValue = isTrimmedIdentity ? value.trim() : value;

      if (isTrimmedIdentity && effectiveValue === "") {
        // Whitespace-only → remove stale credential from the secure store,
        // then clear in-memory state. Delete first so that if it fails we
        // return 500 without having mutated in-memory identity.
        const deleteResult = await deleteSecureKeyAsync(key);
        if (deleteResult === "error") {
          return httpError(
            "INTERNAL_ERROR",
            `Failed to delete stale credential from secure storage: ${service}:${field}`,
            500,
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
          return httpError(
            "INTERNAL_ERROR",
            `Failed to store credential in secure storage (backend: ${getActiveBackendName()})`,
            500,
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
        await initializeProviders(getConfig());
        if (service === "vellum" && field === "assistant_api_key") {
          // Push the API key to CES so managed credential materialization
          // works even though the handshake ran before the key was available.
          const generation = ++apiKeyGeneration;
          const cesClient = getCesClient?.();
          if (cesClient) {
            if (cesClient.isReady()) {
              try {
                await cesClient.updateAssistantApiKey(value);
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
              // CES handshake is still in flight — queue the key propagation
              // so it fires once CES becomes ready.
              void queueApiKeyPropagation(cesClient, value, generation);
            }
          }
        }
      }
      log.info({ service, field }, "Credential added via HTTP");
      return Response.json({ success: true, type, name }, { status: 201 });
    }

    return httpError(
      "BAD_REQUEST",
      `Unknown secret type: ${type}. Valid types: api_key, credential`,
      400,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, type, name }, "Failed to add secret via HTTP");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

export async function handleReadSecret(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    type?: string;
    name?: string;
    reveal?: boolean;
  };

  const { type, name, reveal } = body;

  if (!type || typeof type !== "string") {
    return httpError("BAD_REQUEST", "type is required", 400);
  }
  if (!name || typeof name !== "string") {
    return httpError("BAD_REQUEST", "name is required", 400);
  }

  try {
    let accountKey: string;

    if (type === "api_key") {
      if (
        !API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])
      ) {
        return httpError(
          "BAD_REQUEST",
          `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(
            ", ",
          )}`,
          400,
        );
      }
      accountKey = name;
    } else if (type === "credential") {
      const colonIdx = name.lastIndexOf(":");
      if (colonIdx < 1 || colonIdx === name.length - 1) {
        return httpError(
          "BAD_REQUEST",
          'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
          400,
        );
      }
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      accountKey = credentialKey(service, field);
    } else {
      return httpError(
        "BAD_REQUEST",
        `Unknown secret type: ${type}. Valid types: api_key, credential`,
        400,
      );
    }

    const { value, unreachable } = await getSecureKeyResultAsync(accountKey);
    if (value === undefined) {
      return Response.json({ found: false, unreachable });
    }

    if (reveal) {
      return Response.json({ found: true, value, unreachable: false });
    }

    // Mask the value: show first 10 chars and last 4, hiding at least 3
    const minHidden = 3;
    const maxVisible = Math.max(1, value.length - minHidden);
    const prefixLen = Math.min(10, maxVisible);
    const suffixLen = Math.min(4, Math.max(0, maxVisible - prefixLen));
    const masked = `${value.slice(0, prefixLen)}...${suffixLen > 0 ? value.slice(-suffixLen) : ""}`;

    return Response.json({ found: true, masked, unreachable: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, type, name }, "Failed to read secret via HTTP");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

export async function handleDeleteSecret(req: Request): Promise<Response> {
  let body: { type?: string; name?: string };
  try {
    body = (await req.json()) as { type?: string; name?: string };
  } catch {
    return httpError("BAD_REQUEST", "Request body must be valid JSON", 400);
  }

  const { type, name } = body;

  if (!type || typeof type !== "string") {
    return httpError("BAD_REQUEST", "type is required", 400);
  }
  if (!name || typeof name !== "string") {
    return httpError("BAD_REQUEST", "name is required", 400);
  }

  try {
    if (type === "api_key") {
      if (
        !API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])
      ) {
        return httpError(
          "BAD_REQUEST",
          `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(
            ", ",
          )}`,
          400,
        );
      }
      // Check existence first — the broker always returns "deleted" even
      // for keys that don't exist, so we need a pre-check for 404 semantics.
      const existing = await getSecureKeyAsync(name);
      if (existing === undefined) {
        return httpError("NOT_FOUND", `API key not found: ${name}`, 404);
      }
      const deleteResult = await deleteSecureKeyAsync(name);
      if (deleteResult === "error") {
        return httpError(
          "INTERNAL_ERROR",
          `Failed to delete API key from secure storage: ${name}`,
          500,
        );
      }
      clearEmbeddingBackendCache();
      invalidateConfigCache();
      await initializeProviders(getConfig());
      log.info({ provider: name }, "API key deleted via HTTP");
      return Response.json({ success: true, type, name });
    }

    if (type === "credential") {
      const colonIdx = name.lastIndexOf(":");
      if (colonIdx < 1 || colonIdx === name.length - 1) {
        return httpError(
          "BAD_REQUEST",
          'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
          400,
        );
      }
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      assertMetadataWritable();
      const key = credentialKey(service, field);
      // Check existence first — the broker always returns "deleted" even
      // for keys that don't exist, so we need a pre-check for 404 semantics.
      const existing = await getSecureKeyAsync(key);
      if (existing === undefined) {
        return httpError("NOT_FOUND", `Credential not found: ${name}`, 404);
      }
      const deleteResult = await deleteSecureKeyAsync(key);
      if (deleteResult === "error") {
        return httpError(
          "INTERNAL_ERROR",
          `Failed to delete credential from secure storage: ${name}`,
          500,
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
        await initializeProviders(getConfig());
      }
      log.info({ service, field }, "Credential deleted via HTTP");
      return Response.json({ success: true, type, name });
    }

    return httpError(
      "BAD_REQUEST",
      `Unknown secret type: ${type}. Valid types: api_key, credential`,
      400,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, type, name }, "Failed to delete secret via HTTP");
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

const CREDENTIAL_KEY_PREFIX = "credential/";

export async function handleListSecrets(): Promise<Response> {
  try {
    const { accounts, unreachable } = await listSecureKeysAsync();
    if (unreachable) {
      return Response.json(
        { error: "Credential store is unreachable" },
        { status: 503 },
      );
    }

    const secrets = accounts.map((account) => {
      if (account.startsWith(CREDENTIAL_KEY_PREFIX)) {
        // credential/{service}/{field} → service:field
        const rest = account.slice(CREDENTIAL_KEY_PREFIX.length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx > 0 && slashIdx < rest.length - 1) {
          return {
            type: "credential" as const,
            name: `${rest.slice(0, slashIdx)}:${rest.slice(slashIdx + 1)}`,
          };
        }
      }
      // API key providers are stored with their raw provider name
      return { type: "api_key" as const, name: account };
    });

    return Response.json({ secrets, accounts: secrets });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return httpError("INTERNAL_ERROR", message, 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export interface SecretRouteDeps {
  /** Accessor for the CES client, used to push API key updates after hatch. */
  getCesClient?: () => CesClient | undefined;
}

export function secretRouteDefinitions(
  deps?: SecretRouteDeps,
): RouteDefinition[] {
  return [
    {
      endpoint: "secrets",
      method: "POST",
      handler: async ({ req }) => handleAddSecret(req, deps?.getCesClient),
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
    },
    {
      endpoint: "secrets",
      method: "DELETE",
      handler: async ({ req }) => handleDeleteSecret(req),
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
    },
    {
      endpoint: "secrets",
      method: "GET",
      handler: async () => handleListSecrets(),
      summary: "List secrets",
      description: "Return the names (not values) of all stored secrets.",
      tags: ["secrets"],
      responseBody: z.object({
        secrets: z
          .array(z.unknown())
          .describe("List of secret metadata entries, each with type and name"),
        accounts: z
          .array(z.unknown())
          .describe("Alias for secrets (same data)"),
      }),
    },
    {
      endpoint: "secrets/read",
      method: "POST",
      handler: async ({ req }) => handleReadSecret(req),
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
        masked: z
          .string()
          .describe("Masked value (when reveal=false and found)"),
        unreachable: z.boolean(),
      }),
    },
  ];
}
