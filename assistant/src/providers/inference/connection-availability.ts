/**
 * Shared availability computation for a (provider, connection) pair: whether
 * the connection exists, carries a usable credential, and can actually serve
 * the provider.
 *
 * On read paths the status is reported, not enforced — a dangling or
 * uncredentialed connection is a valid persisted state that surfaces an
 * explainable error at dispatch time. The dedicated inference-profile write
 * routes (create / update / set-active / conversation-scoped pin) are the
 * exception: they refuse to persist a selection that provably cannot dispatch,
 * because those writes are what a chat turn resolves through. Generic
 * `config set` writes and dispatch itself stay report-only.
 *
 * Consumed by the default-provider status route (`llm.defaultProvider`) and
 * the inference-profile routes (per-profile availability) so the two never
 * drift.
 */

import { getDb } from "../../persistence/db-connection.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyResultAsync } from "../../security/secure-keys.js";
import {
  describeSubscriptionModelIncompatibility,
  isConnectionCompatibleWithModel,
} from "../connection-model-compat.js";
import { PROVIDER_CATALOG } from "../model-catalog.js";
import { resolveManagedProxyContext } from "../platform-proxy/context.js";
import {
  ConnectionResolutionError,
  resolveRoutingIdentity,
} from "../routing-identity.js";
import {
  isVellumManagedConnection,
  MANAGED_ROUTABLE_PROVIDERS,
} from "../vellum-model-routing.js";
import { ROUTING_IDENTITY_PROVIDERS } from "./auth.js";
import { getConnection, listConnections } from "./connections.js";

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
      // Keyless providers (catalog setupMode "keyless", e.g. ollama) and
      // openai-compatible endpoints (dual-mode: local servers are keyless)
      // legitimately dispatch with none-auth — mirror
      // `createAdapterFromConnection`, which only rejects none-auth for
      // keyed catalog entries.
      const isKeyless =
        PROVIDER_CATALOG.find((entry) => entry.id === provider)?.setupMode ===
        "keyless";
      if (isKeyless || provider === "openai-compatible") {
        return { status: "ok" };
      }
      return {
        status: "unsupported_auth",
        message: `Connection "${resolvedConnectionName}" has no authentication configured, but provider "${provider}" requires an API key. Add a key ${SETTINGS_HINT}.`,
      };
    }
  }
}

/**
 * Statuses that mean a profile provably cannot serve a request. `unknown` is
 * excluded on purpose: it means the credential store could not be reached, not
 * that the credential is absent, and treating a CES outage as a broken profile
 * would block writes that are actually fine.
 */
const UNAVAILABLE_STATUSES: ReadonlySet<ConnectionAvailabilityStatus> = new Set(
  [
    "missing_connection",
    "missing_credential",
    "provider_mismatch",
    "unsupported_auth",
    "vellum_unauthenticated",
  ],
);

/** Whether an availability verdict means dispatch would provably fail. */
export function isUnavailable(
  availability: ConnectionAvailability | null,
): boolean {
  return availability !== null && UNAVAILABLE_STATUSES.has(availability.status);
}

/**
 * Availability of a whole effective profile entry, judged the way dispatch
 * judges it:
 *
 *   - routing identities (`vellum`, `chatgpt`) resolve to their canonical row
 *     and derived upstream;
 *   - a pinned `provider_connection` is judged directly;
 *   - a provider with no pinned connection is judged against the connection
 *     dispatch would auto-resolve (an active, model-compatible row for that
 *     provider) — with no such row, the profile cannot serve requests.
 *
 * Returns null when there is nothing to judge (no provider, e.g. mix profiles).
 */
export async function computeProfileAvailability(
  entry: Record<string, unknown>,
): Promise<ConnectionAvailability | null> {
  const provider = entry.provider;
  if (typeof provider !== "string") {
    return null;
  }
  const model = typeof entry.model === "string" ? entry.model : undefined;

  // Routing-identity profiles carry no provider_connection. A model the
  // identity cannot route reports as a mismatch rather than throwing —
  // availability annotates, it must not fail the profiles read.
  if (ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    try {
      const identity = resolveRoutingIdentity(provider, model);
      if (!identity) {
        return null;
      }
      return await computeConnectionAvailability(
        identity.expectedProvider,
        identity.connectionName,
      );
    } catch (err) {
      return {
        status: "provider_mismatch",
        message:
          err instanceof ConnectionResolutionError
            ? err.message
            : `Model "${model ?? "<unset>"}" cannot be routed by provider "${provider}".`,
      };
    }
  }

  const pinned = entry.provider_connection;
  if (typeof pinned === "string") {
    return computeConnectionAvailability(provider, pinned);
  }

  // Mirror the dispatch-time auto-resolve (`resolveConfiguredProvider`): with
  // no pinned connection, the first active model-compatible row for the
  // provider serves the request, and none means dispatch returns no provider.
  let candidates;
  try {
    candidates = listConnections(getDb(), { provider });
  } catch {
    return {
      status: "unknown",
      message: `Connections for provider "${provider}" could not be looked up. Try again shortly.`,
    };
  }
  const active = candidates.find((candidate) =>
    isConnectionCompatibleWithModel(candidate, model),
  );
  if (active) {
    return computeConnectionAvailability(provider, active.name);
  }
  return {
    status: "missing_connection",
    message:
      describeSubscriptionModelIncompatibility(candidates, model) ??
      `Provider "${provider}" is a valid provider id, but no ${provider} connection/API key is configured, so this profile cannot serve requests.`,
  };
}
