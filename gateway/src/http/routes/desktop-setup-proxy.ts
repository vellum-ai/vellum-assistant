import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";

export function createDesktopSetupProxyHandler(config: GatewayConfig) {
  return (req: Request): Promise<Response> =>
    proxyForwardToResponse(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: "/v1/desktop/setup",
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
}
