import pino from "pino";
import type { GatewayConfig } from "../../config.js";
import { validateBearerToken } from "../auth/bearer.js";

const log = pino({ name: "gateway:runtime-proxy" });

export function createRuntimeProxyHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (
      config.runtimeProxyRequireAuth &&
      config.runtimeProxyBearerToken &&
      req.method !== "OPTIONS"
    ) {
      const authResult = validateBearerToken(
        req.headers.get("authorization"),
        config.runtimeProxyBearerToken,
      );
      if (!authResult.authorized) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const upstream = `${config.assistantRuntimeBaseUrl}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    headers.delete("host");

    let response: Response;
    try {
      response = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.body,
        // @ts-expect-error Bun supports duplex on Request
        duplex: "half",
      });
    } catch (err) {
      log.error({ err, method: req.method, path: url.pathname }, "Upstream connection failed");
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
}
