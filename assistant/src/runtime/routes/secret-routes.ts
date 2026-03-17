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
import { setSentryOrganizationId } from "../../instrument.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import { validateAnthropicApiKey } from "../../providers/anthropic/client.js";
import { initializeProviders } from "../../providers/registry.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
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
  const body = (await req.json()) as {
    type?: string;
    name?: string;
    value?: string;
  };

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
      // Validate Anthropic API keys before storing
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
      }

      const stored = await setSecureKeyAsync(name, value);
      if (!stored) {
        return httpError(
          "INTERNAL_ERROR",
          "Failed to store API key in secure storage",
          500,
        );
      }
      invalidateConfigCache();
      await initializeProviders(getConfig());
      log.info({ provider: name }, "API key updated via HTTP");
      return Response.json({ success: true, type, name }, { status: 201 });
    }

    if (type === "credential") {
      const colonIdx = name.indexOf(":");
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
        }
        deleteCredentialMetadata(service, field);
      } else {
        const stored = await setSecureKeyAsync(key, effectiveValue);
        if (!stored) {
          return httpError(
            "INTERNAL_ERROR",
            "Failed to store credential in secure storage",
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

export async function handleDeleteSecret(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    type?: string;
    name?: string;
  };

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
      invalidateConfigCache();
      await initializeProviders(getConfig());
      log.info({ provider: name }, "API key deleted via HTTP");
      return Response.json({ success: true, type, name });
    }

    if (type === "credential") {
      const colonIdx = name.indexOf(":");
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
    },
    {
      endpoint: "secrets",
      method: "DELETE",
      handler: async ({ req }) => handleDeleteSecret(req),
    },
  ];
}
