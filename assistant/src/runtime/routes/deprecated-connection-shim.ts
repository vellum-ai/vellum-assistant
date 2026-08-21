/**
 * Deprecated wire shims for the retired connection-binding request fields
 * (`connection` on the inference-profile routes, `provider_connection` on
 * the config profile PUT/PATCH paths). Pre-0.11.4 clients still pin a
 * credential through them; silently stripping the pin would persist a bare
 * vendor whose routing differs from what the caller selected.
 *
 * Both fields translate with workspace migration 148's verified-fold
 * semantics instead: a row that exists and whose kind agrees with the sent
 * provider becomes the profile's `provider` (the entry name); anything
 * unverifiable is rejected loudly. Delete with the fleet-telemetry-gated
 * legacy shims in clients/web.
 */

import { getDb } from "../../persistence/db-connection.js";
import { ROUTING_IDENTITY_PROVIDERS } from "../../providers/inference/auth.js";
import { getConnection } from "../../providers/inference/connections.js";
import { MANAGED_ROUTABLE_PROVIDERS } from "../../providers/vellum-model-routing.js";
import { BadRequestError } from "./errors.js";

/**
 * Translate a deprecated connection-binding value into the entries model.
 * Returns the provider value to store, or throws `BadRequestError` when the
 * binding is unverifiable (row missing or kind-disagreeing). Kind agreement
 * mirrors dispatch: same provider, a "chatgpt" row for a declared "openai",
 * or a "vellum" row for a declared managed-routable provider.
 */
export function translateDeprecatedConnection(
  provider: string | undefined,
  connectionName: string,
): string | undefined {
  if (provider !== undefined && ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    // Identity profiles carry no binding by definition; a stray one is
    // ignored (migration 148's identity rule).
    return provider;
  }
  if (connectionName === provider) {
    // The bare vendor value already means the default entry of that kind.
    return provider;
  }
  const row = getConnection(getDb(), connectionName);
  if (!row) {
    throw new BadRequestError(
      `Connection "${connectionName}" does not exist. Omit the deprecated ` +
        `connection field, or set "provider" to the name of an existing connection.`,
    );
  }
  const kindAgrees =
    provider === undefined ||
    row.provider === provider ||
    (row.provider === "chatgpt" && provider === "openai") ||
    (row.provider === "vellum" && MANAGED_ROUTABLE_PROVIDERS.has(provider));
  if (!kindAgrees) {
    throw new BadRequestError(
      `Connection "${connectionName}" has provider "${row.provider}" and ` +
        `cannot serve provider "${provider}". Omit the deprecated connection ` +
        `field, or point it at a connection matching the profile's provider.`,
    );
  }
  return connectionName;
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Fold the legacy `provider_connection` field on every profile entry of a
 * raw config-write fragment, in place: a present string binding translates
 * through {@link translateDeprecatedConnection} into the entry's `provider`
 * (or throws), while `null`/empty values are dropped as no-ops. The key
 * itself never survives into the merge, so it cannot land in raw config.
 *
 * `currentRaw` supplies each profile's stored provider for fragments that
 * send only the binding.
 */
export function foldDeprecatedProfileBindings(
  patch: unknown,
  currentRaw: Record<string, unknown>,
): void {
  const profiles = readPlainObject(
    readPlainObject(readPlainObject(patch)?.llm)?.profiles,
  );
  if (!profiles) {
    return;
  }
  const existingProfiles = readPlainObject(
    readPlainObject(currentRaw.llm)?.profiles,
  );
  for (const [name, value] of Object.entries(profiles)) {
    const entry = readPlainObject(value);
    if (!entry || !Object.hasOwn(entry, "provider_connection")) {
      continue;
    }
    const binding = entry.provider_connection;
    delete entry.provider_connection;
    if (typeof binding !== "string" || binding.length === 0) {
      // An explicit clear of a field that no longer exists: a no-op.
      continue;
    }
    const existing = readPlainObject(existingProfiles?.[name]);
    const provider =
      typeof entry.provider === "string"
        ? entry.provider
        : typeof existing?.provider === "string"
          ? existing.provider
          : undefined;
    const translated = translateDeprecatedConnection(provider, binding);
    if (translated !== undefined) {
      entry.provider = translated;
    }
  }
}
