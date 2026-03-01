import type { ManagedGatewayConfig } from "./config.js";
import type { ManagedGatewayInboundEvent } from "./managed-inbound-event.js";
import { buildManagedInternalAuthHeaders } from "./managed-internal-auth-headers.js";
import type { ManagedRouteResolution } from "./managed-route-resolution-client.js";
import type { ManagedGatewayUpstreamFetch } from "./route-resolve.js";
import { buildUpstreamUrl } from "./upstream-url.js";

export const MANAGED_GATEWAY_INBOUND_DISPATCH_PATH = "/v1/internal/managed-gateway/inbound/dispatch/";
const INBOUND_DISPATCH_SCOPE = "events:dispatch";

export type ManagedInboundDispatchReceipt = {
  status: string;
  routeId: string;
  assistantId: string;
  eventId?: string;
  duplicate?: boolean;
};

export type ManagedInboundDispatchResult =
  | {
    ok: true;
    dispatch: ManagedInboundDispatchReceipt;
  }
  | {
    ok: false;
    status: number;
    error: {
      code: string;
      detail: string;
    };
  };

export async function dispatchManagedInboundEvent(
  config: ManagedGatewayConfig,
  args: {
    route: ManagedRouteResolution;
    normalizedEvent: ManagedGatewayInboundEvent;
    fetchImpl?: ManagedGatewayUpstreamFetch;
  },
): Promise<ManagedInboundDispatchResult> {
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

  const authHeaders = buildManagedInternalAuthHeaders(config, INBOUND_DISPATCH_SCOPE);
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

  const upstreamUrl = buildUpstreamUrl(
    config.djangoInternalBaseUrl,
    MANAGED_GATEWAY_INBOUND_DISPATCH_PATH,
  );

  let response: Response;
  try {
    response = await fetchFn(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        route_id: args.route.routeId,
        assistant_id: args.route.assistantId,
        normalized_event: args.normalizedEvent,
      }),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      error: {
        code: "upstream_unavailable",
        detail: "Managed inbound dispatch upstream is unavailable.",
      },
    };
  }

  if (response.status === 202) {
    const payload = await safeJson(response);
    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        status: 502,
        error: {
          code: "upstream_invalid_response",
          detail: "Managed inbound dispatch upstream returned an invalid response payload.",
        },
      };
    }

    const statusValue = asNonEmptyString(payload.status);
    const routeId = asNonEmptyString(payload.route_id);
    const assistantId = asNonEmptyString(payload.assistant_id);
    if (!statusValue || !routeId || !assistantId) {
      return {
        ok: false,
        status: 502,
        error: {
          code: "upstream_invalid_response",
          detail: "Managed inbound dispatch upstream returned an invalid response payload.",
        },
      };
    }

    const receipt: ManagedInboundDispatchReceipt = {
      status: statusValue,
      routeId,
      assistantId,
    };
    const eventId = asNonEmptyString(payload.event_id);
    if (eventId) {
      receipt.eventId = eventId;
    }
    if (typeof payload.duplicate === "boolean") {
      receipt.duplicate = payload.duplicate;
    }

    return {
      ok: true,
      dispatch: receipt,
    };
  }

  const payload = await safeJson(response);
  const errorPayload = asRecord(payload?.error);
  const detail = asNonEmptyString(errorPayload?.detail)
    || asNonEmptyString(payload?.detail)
    || `Managed inbound dispatch upstream returned status ${response.status}.`;
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
