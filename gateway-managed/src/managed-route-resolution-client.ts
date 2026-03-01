import type { ManagedGatewayConfig } from "./config.js";
import { buildManagedInternalAuthHeaders } from "./managed-internal-auth-headers.js";
import {
  MANAGED_GATEWAY_ROUTE_RESOLVE_PATH,
  type ManagedGatewayUpstreamFetch,
  normalizeIdentityKey,
} from "./route-resolve.js";

const ROUTE_RESOLVE_SCOPE = "routes:resolve";

export type ManagedRouteResolution = {
  routeId: string;
  assistantId: string;
  provider: string;
  routeType: string;
  identityKey: string;
};

export type ManagedRouteResolutionResult =
  | {
    ok: true;
    route: ManagedRouteResolution;
  }
  | {
    ok: false;
    status: number;
    error: {
      code: string;
      detail: string;
    };
  };

export async function resolveManagedRoute(
  config: ManagedGatewayConfig,
  args: {
    routeType: "sms" | "voice";
    identityKey: string;
    fetchImpl?: ManagedGatewayUpstreamFetch;
  },
): Promise<ManagedRouteResolutionResult> {
  if (!config.djangoInternalBaseUrl) {
    return {
      ok: false,
      status: 503,
      error: {
        code: "upstream_unconfigured",
        detail: "Managed gateway Django internal base URL is not configured.",
      },
    };
  }

  const authHeaders = buildManagedInternalAuthHeaders(config, ROUTE_RESOLVE_SCOPE);
  if (!authHeaders) {
    return {
      ok: false,
      status: 500,
      error: {
        code: "internal_auth_unavailable",
        detail: "No active managed gateway internal auth credentials are available.",
      },
    };
  }

  const fetchFn = args.fetchImpl || fetch;
  const headers = new Headers(authHeaders);
  headers.set("content-type", "application/json");

  const upstreamUrl = new URL(
    MANAGED_GATEWAY_ROUTE_RESOLVE_PATH,
    config.djangoInternalBaseUrl,
  ).toString();

  let response: Response;
  try {
    response = await fetchFn(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "twilio",
        route_type: args.routeType,
        identity_key: normalizeIdentityKey(args.identityKey),
      }),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      error: {
        code: "upstream_unavailable",
        detail: "Managed route resolver upstream is unavailable.",
      },
    };
  }

  if (response.status === 200) {
    const payload = await safeJson(response);
    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        status: 502,
        error: {
          code: "upstream_invalid_response",
          detail: "Managed route resolver upstream returned an invalid response payload.",
        },
      };
    }

    const routeId = asNonEmptyString(payload.route_id);
    const assistantId = asNonEmptyString(payload.assistant_id);
    const provider = asNonEmptyString(payload.provider);
    const routeType = asNonEmptyString(payload.route_type);
    const identityKey = asNonEmptyString(payload.identity_key);

    if (!routeId || !assistantId || !provider || !routeType || !identityKey) {
      return {
        ok: false,
        status: 502,
        error: {
          code: "upstream_invalid_response",
          detail: "Managed route resolver upstream returned an invalid response payload.",
        },
      };
    }

    return {
      ok: true,
      route: {
        routeId,
        assistantId,
        provider,
        routeType,
        identityKey,
      },
    };
  }

  const payload = await safeJson(response);
  const errorPayload = asRecord(payload?.error);
  const detail = asNonEmptyString(errorPayload?.detail)
    || asNonEmptyString(payload?.detail)
    || `Managed route resolver upstream returned status ${response.status}.`;
  const code = asNonEmptyString(errorPayload?.code)
    || (response.status === 404 ? "managed_route_not_found" : "upstream_error");

  if (response.status === 400 || response.status === 401 || response.status === 404) {
    return {
      ok: false,
      status: response.status,
      error: { code, detail },
    };
  }

  return {
    ok: false,
    status: 502,
    error: {
      code: "upstream_error",
      detail,
    },
  };
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await response.json();
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
