import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import type { RouteDefinition } from "../router.js";
import { fetchImpl } from "../../fetch.js";

function createDesktopProxyHandler(
  config: GatewayConfig,
  resource: "setup" | "apps",
) {
  return (req: Request): Promise<Response> =>
    proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: `/v1/desktop/${resource}`,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
}

export function createDesktopControlRoutes(
  config: GatewayConfig,
): RouteDefinition[] {
  return (["setup", "apps"] as const).flatMap((resource) => {
    const handler = createDesktopProxyHandler(config, resource);
    return (["GET", "POST"] as const).flatMap((method) => [
      {
        path: new RegExp(`^/v1/desktop/${resource}/?$`),
        method,
        auth: "edge-guardian" as const,
        handler,
      },
      {
        path: new RegExp(`^/v1/assistants/[^/]+/desktop/${resource}/?$`),
        method,
        auth: "edge-guardian" as const,
        handler,
      },
    ]);
  });
}
