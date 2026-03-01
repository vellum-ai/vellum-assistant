import type { ManagedGatewayConfig } from "./config.js";
import { withInternalAuth } from "./internal-auth.js";

export const MANAGED_GATEWAY_ROUTE_RESOLVE_PATH = "/v1/internal/managed-gateway/routes/resolve/";
const MANAGED_GATEWAY_ROUTE_RESOLVE_SCOPE = "routes:resolve";

export type ManagedGatewayUpstreamFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ManagedGatewayRouteResolvePayload = {
  provider: string;
  route_type: string;
  identity_key: string;
};

export function createRouteResolveHandler(
  config: ManagedGatewayConfig,
  fetchImpl?: ManagedGatewayUpstreamFetch,
): (request: Request) => Promise<Response> {
  const upstreamFetch: ManagedGatewayUpstreamFetch = fetchImpl || fetch;

  return withInternalAuth(
    config,
    async (request: Request): Promise<Response> => {
      const payload = await parseRouteResolvePayload(request);
      if (!payload) {
        return Response.json(
          {
            error: {
              code: "validation_error",
              detail: "Invalid route resolve payload.",
            },
          },
          { status: 400 },
        );
      }

      if (!config.djangoInternalBaseUrl) {
        return Response.json(
          {
            error: {
              code: "upstream_unconfigured",
              detail: "Managed gateway Django internal base URL is not configured.",
            },
          },
          { status: 503 },
        );
      }

      const upstreamUrl = new URL(
        MANAGED_GATEWAY_ROUTE_RESOLVE_PATH,
        config.djangoInternalBaseUrl,
      ).toString();

      const upstreamHeaders = buildUpstreamHeaders(request, config);

      try {
        const upstreamResponse = await upstreamFetch(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(payload),
        });
        return mapUpstreamResponse(upstreamResponse);
      } catch {
        return Response.json(
          {
            error: {
              code: "upstream_unavailable",
              detail: "Managed route resolver upstream is unavailable.",
            },
          },
          { status: 502 },
        );
      }
    },
    MANAGED_GATEWAY_ROUTE_RESOLVE_SCOPE,
  );
}

async function parseRouteResolvePayload(
  request: Request,
): Promise<ManagedGatewayRouteResolvePayload | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const body = parsed as Record<string, unknown>;

  try {
    return {
      provider: normalizeLookupValue(body.provider),
      route_type: normalizeLookupValue(body.route_type),
      identity_key: normalizeIdentityKey(body.identity_key),
    };
  } catch {
    return null;
  }
}

function normalizeLookupValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("lookup field must be a string");
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error("lookup field cannot be blank");
  }

  return normalized;
}

export function normalizeIdentityKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("identity_key must be a string");
  }

  let normalized = raw.trim().toLowerCase();
  if (normalized.startsWith("tel:")) {
    normalized = normalized.slice("tel:".length);
  }
  normalized = normalized.replaceAll(" ", "");

  if (!normalized) {
    throw new Error("identity_key cannot be blank");
  }

  return normalized;
}

function buildUpstreamHeaders(
  request: Request,
  config: ManagedGatewayConfig,
): Headers {
  const headers = new Headers({
    "content-type": "application/json",
  });

  if (config.internalAuth.mode === "bearer") {
    const authorization = request.headers.get("authorization");
    if (authorization) {
      headers.set("authorization", authorization);
    }
    return headers;
  }

  const mtlsPrincipal = request.headers.get(config.internalAuth.mtlsPrincipalHeader);
  if (mtlsPrincipal) {
    headers.set(config.internalAuth.mtlsPrincipalHeader, mtlsPrincipal);
  }

  const mtlsAudience = request.headers.get(config.internalAuth.mtlsAudienceHeader);
  if (mtlsAudience) {
    headers.set(config.internalAuth.mtlsAudienceHeader, mtlsAudience);
  }

  const mtlsScopes = request.headers.get(config.internalAuth.mtlsScopesHeader);
  if (mtlsScopes) {
    headers.set(config.internalAuth.mtlsScopesHeader, mtlsScopes);
  }

  return headers;
}

function mapUpstreamResponse(upstreamResponse: Response): Response {
  if (
    upstreamResponse.status !== 200
    && upstreamResponse.status !== 400
    && upstreamResponse.status !== 401
    && upstreamResponse.status !== 404
  ) {
    return Response.json(
      {
        error: {
          code: "upstream_error",
          detail: `Managed route resolver upstream returned unexpected status ${upstreamResponse.status}.`,
        },
      },
      { status: 502 },
    );
  }

  const passthroughHeaders = new Headers();
  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) {
    passthroughHeaders.set("content-type", contentType);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: passthroughHeaders,
  });
}
