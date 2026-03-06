import {
  API_KEY_PROVIDERS,
  getConfig,
  invalidateConfigCache,
} from "../../config/loader.js";
import { initializeProviders } from "../../providers/registry.js";
import { deleteSecureKey, setSecureKey } from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("runtime-http");

export async function handleAddSecret(req: Request): Promise<Response> {
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
      const stored = setSecureKey(name, value);
      if (!stored) {
        return httpError(
          "INTERNAL_ERROR",
          "Failed to store API key in secure storage",
          500,
        );
      }
      invalidateConfigCache();
      initializeProviders(getConfig());
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
      const key = `credential:${service}:${field}`;
      const stored = setSecureKey(key, value);
      if (!stored) {
        return httpError(
          "INTERNAL_ERROR",
          "Failed to store credential in secure storage",
          500,
        );
      }
      upsertCredentialMetadata(service, field, {});
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
      const deleteResult = deleteSecureKey(name);
      if (deleteResult === "error") {
        return httpError(
          "INTERNAL_ERROR",
          `Failed to delete API key from secure storage: ${name}`,
          500,
        );
      }
      if (deleteResult === "not-found") {
        return httpError("NOT_FOUND", `API key not found: ${name}`, 404);
      }
      invalidateConfigCache();
      initializeProviders(getConfig());
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
      const key = `credential:${service}:${field}`;
      const deleteResult = deleteSecureKey(key);
      if (deleteResult === "error") {
        return httpError(
          "INTERNAL_ERROR",
          `Failed to delete credential from secure storage: ${name}`,
          500,
        );
      }
      if (deleteResult === "not-found") {
        return httpError("NOT_FOUND", `Credential not found: ${name}`, 404);
      }
      deleteCredentialMetadata(service, field);
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

export function secretRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "secrets",
      method: "POST",
      handler: async ({ req }) => handleAddSecret(req),
    },
    {
      endpoint: "secrets",
      method: "DELETE",
      handler: async ({ req }) => handleDeleteSecret(req),
    },
  ];
}
