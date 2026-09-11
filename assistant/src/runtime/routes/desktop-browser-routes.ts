import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { desktopBrowserBridge } from "../../desktop/desktop-browser-bridge.js";
import { desktopExtensionAsset } from "../../desktop/desktop-extension.js";
import { isAssistantDesktopEnabled } from "../../desktop/desktop-feature.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const request = z.object({
  token: z.string().length(64),
  connection: z.string().uuid(),
  kind: z.enum(["connect", "poll", "message"]),
  message: z.record(z.string(), z.unknown()).optional(),
  guardian: z.string().min(1).max(256),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "desktop_browser_bridge",
    endpoint: "desktop/browser/bridge",
    method: "POST",
    policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
    requestBody: request,
    handler: ({ body }) => {
      if (!isAssistantDesktopEnabled(getConfig())) {
        throw new NotFoundError("Desktop browser is unavailable");
      }
      const data = request.parse(body);
      return desktopBrowserBridge.exchange(data, data.guardian);
    },
  },
  ...(["update", "package"] as const).map(
    (kind): RouteDefinition => ({
      operationId: `desktop_browser_${kind}`,
      endpoint: `desktop/browser/${kind}`,
      method: "GET",
      policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
      handler: () => {
        if (!isAssistantDesktopEnabled(getConfig())) {
          throw new NotFoundError("Desktop browser is unavailable");
        }
        return desktopExtensionAsset(kind);
      },
    }),
  ),
];
