/**
 * Shared availability computation for a (provider, connection) pair: whether
 * the connection exists, carries a usable credential, and can actually serve
 * the provider. The status is reported, never enforced — a dangling or
 * uncredentialed connection is a valid persisted state that surfaces an
 * explainable error at dispatch time.
 *
 * Consumed by the default-provider status route (`llm.defaultProvider`) and
 * the inference-profile list route (per-profile `provider_connection`) so the
 * two never drift.
 */

import { getDb } from "../../persistence/db-connection.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyResultAsync } from "../../security/secure-keys.js";
import { PROVIDER_CATALOG } from "../model-catalog.js";
import { resolveManagedProxyContext } from "../platform-proxy/context.js";
import {
  isVellumManagedConnection,
  MANAGED_ROUTABLE_PROVIDERS,
} from "../vellum-model-routing.js";
import { getConnection } from "./connections.js";

export type ConnectionAvailabilityStatus =
  | "ok"
  | "missing_connection"
  | "missing_credential"
  | "provider_mismatch"
  | "unsupported_auth"
  | "vellum_unauthenticated"
  | "unknown";

export interface ConnectionAvailability {
  status: ConnectionAvailabilityStatus;
  /** Present on every non-`ok` status: names the broken thing and the fix. */
  message?: string;
}

const SETTINGS_HINT = "in Settings → Models & Services";

/**
 * Availability of the Vellum-managed platform proxy: signed in and reachable.
 */
export async function vellumConnectionAvailability(): Promise<ConnectionAvailability> {
  const ctx = await resolveManagedProxyContext();
  if (ctx.enabled) {
    return { status: "ok" };
  }
  if (!ctx.platformBaseUrl) {
    return {
      status: "vellum_unauthenticated",
      message: "Not signed in to Vellum — the platform URL is not configured.",
    };
  }
  // The context collapses an unreachable credential read into "no key";
  // re-read reachability-aware so a CES outage isn't reported as logged out.
  const key = await getSecureKeyResultAsync(
    credentialKey("vellum", "assistant_api_key"),
  );
  if (key.value != null) {
    return { status: "ok" };
  }
  if (key.unreachable) {
    return {
      status: "unknown",
      message:
        "The credential store is unreachable, so Vellum sign-in could not be verified. Try again shortly.",
    };
  }
  return {
    status: "vellum_unauthenticated",
    message:
      "Not signed in to Vellum — no assistant API key is stored. Log in to use Vellum-managed inference.",
  };
}

function vellumManagedMismatch(
  resolvedConnectionName: string,
  provider: string,
): ConnectionAvailability {
  return {
    status: "provider_mismatch",
    message: `Connection "${resolvedConnectionName}" is the Vellum-managed connection, which cannot serve provider "${provider}". Pick a connection for "${provider}" ${SETTINGS_HINT}.`,
  };
}

/**
 * Compute the availability of `resolvedConnectionName` when used to serve
 * `provider`. Mirrors the dispatch-time resolution checks
 * (`tryResolveProviderForConnectionName` / `resolveAuth`) so a status of `ok`
 * means dispatch would succeed.
 */
export async function computeConnectionAvailability(
  provider: string,
  resolvedConnectionName: string,
): Promise<ConnectionAvailability> {
  // Every path loads the row — even the canonical `vellum` name. Boot seeding
  // (`seedCanonicalConnections`) deliberately leaves a user-owned connection
  // that claims that name in place, and dispatch reads whatever row is
  // stored, so availability must judge the actual row, not the name.
  let connection;
  try {
    connection = getConnection(getDb(), resolvedConnectionName);
  } catch {
    return {
      status: "unknown",
      message: `Connection "${resolvedConnectionName}" could not be looked up. Try again shortly.`,
    };
  }
  if (!connection) {
    return {
      status: "missing_connection",
      message: `No connection named "${resolvedConnectionName}" exists for provider "${provider}". Add one ${SETTINGS_HINT}.`,
    };
  }

  // Mirror the dispatch-time provider check (`tryResolveProviderForConnectionName`):
  // the provider-agnostic Vellum-managed connection routes managed-routable
  // providers via platform auth; any other provider mismatch fails there, so
  // usable credentials must not read as ok.
  if (isVellumManagedConnection(connection)) {
    if (provider === "vellum" || MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
      return vellumConnectionAvailability();
    }
    return vellumManagedMismatch(resolvedConnectionName, provider);
  }
  if (connection.provider !== provider) {
    return {
      status: "provider_mismatch",
      message: `Connection "${resolvedConnectionName}" is for provider "${connection.provider}", but the requested provider is "${provider}". Pick a connection for "${provider}" ${SETTINGS_HINT}.`,
    };
  }

  switch (connection.auth.type) {
    // Schema-accepted but not dispatchable: `resolveAuth` returns
    // not_implemented for service_account, so a stored credential still
    // cannot serve inference.
    case "service_account":
      return {
        status: "unsupported_auth",
        message: `Connection "${resolvedConnectionName}" uses service-account auth, which inference does not support yet. Pick a connection with a different auth type.`,
      };
    case "api_key":
    case "oauth_subscription": {
      const result = await getSecureKeyResultAsync(connection.auth.credential);
      if (result.value != null) {
        return { status: "ok" };
      }
      if (result.unreachable) {
        // Credential store down ≠ credential missing. Reporting
        // `missing_credential` here would send the user re-entering a key
        // that is probably still stored.
        return {
          status: "unknown",
          message: `The credential store is unreachable, so the credential for connection "${resolvedConnectionName}" could not be verified. Try again shortly.`,
        };
      }
      const noun =
        connection.auth.type === "api_key" ? "API key" : "credential";
      return {
        status: "missing_credential",
        message: `Connection "${resolvedConnectionName}" has no ${noun} stored. Add one ${SETTINGS_HINT}.`,
      };
    }
    case "platform":
      // The managed proxy only serves managed-routable upstreams
      // (`resolveAuth` → `buildManagedBaseUrl` has no proxy path for the
      // rest), so platform auth on e.g. openrouter can never dispatch.
      if (MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
        return vellumConnectionAvailability();
      }
      return {
        status: "unsupported_auth",
        message: `Connection "${resolvedConnectionName}" uses Vellum platform auth, which cannot serve provider "${provider}". Add an API-key connection for "${provider}" ${SETTINGS_HINT}.`,
      };
    case "none": {
      // Keyless providers (catalog setupMode "keyless", e.g. ollama)
      // legitimately dispatch with none-auth — mirror
      // `createAdapterFromConnection`, which only rejects none-auth for
      // keyed catalog entries.
      const isKeyless =
        PROVIDER_CATALOG.find((entry) => entry.id === provider)?.setupMode ===
        "keyless";
      if (isKeyless) {
        return { status: "ok" };
      }
      return {
        status: "unsupported_auth",
        message: `Connection "${resolvedConnectionName}" has no authentication configured, but provider "${provider}" requires an API key. Add a key ${SETTINGS_HINT}.`,
      };
    }
  }
}
