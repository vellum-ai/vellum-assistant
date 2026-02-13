import pino from "pino";
import type { GatewayConfig } from "../../config.js";
import { validateBearerToken } from "../auth/bearer.js";

const log = pino({ name: "gateway:runtime-proxy" });

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function stripHopByHop(headers: Headers): Headers {
  const cleaned = new Headers(headers);

  // Also strip any headers listed in the Connection header value
  const connectionValue = cleaned.get("connection");
  if (connectionValue) {
    for (const name of connectionValue.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) {
        try {
          cleaned.delete(trimmed);
        } catch {
          // Ignore invalid header names (e.g., malformed Connection tokens like "@@@")
        }
      }
    }
  }

  for (const h of HOP_BY_HOP_HEADERS) {
    cleaned.delete(h);
  }
  return cleaned;
}

export function createRuntimeProxyHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const start = performance.now();
    const url = new URL(req.url);

    if (config.runtimeProxyRequireAuth && req.method !== "OPTIONS") {
      if (!config.runtimeProxyBearerToken) {
        return Response.json({ error: "Server misconfigured" }, { status: 500 });
      }
      const authResult = validateBearerToken(
        req.headers.get("authorization"),
        config.runtimeProxyBearerToken,
      );
      if (!authResult.authorized) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const upstream = `${config.assistantRuntimeBaseUrl}${url.pathname}${url.search}`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");

    let response: Response;
    try {
      response = await fetch(upstream, {
        method: req.method,
        headers: reqHeaders,
        body: req.body,
        // @ts-expect-error Bun supports duplex on Request
        duplex: "half",
      });
    } catch (err) {
      const duration = Math.round(performance.now() - start);
      log.error(
        { err, method: req.method, path: url.pathname, duration },
        "Upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);
    log.info(
      { method: req.method, path: url.pathname, status: response.status, duration },
      "Proxy request completed",
    );

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  };
}
