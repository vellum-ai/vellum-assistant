import pino from "pino";
import type { GatewayConfig } from "../../config.js";

const log = pino({ name: "gateway:runtime-proxy" });

export function createRuntimeProxyHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
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
