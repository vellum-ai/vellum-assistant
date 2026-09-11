import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { desktopControl } from "../../desktop/desktop-control.js";
import { isAssistantDesktopEnabled } from "../../desktop/desktop-feature.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const request = z.object({ action: z.enum(["take", "allow"]) });
const status = z.object({ state: z.enum(["idle", "assistant", "human"]) });

export const ROUTES: RouteDefinition[] = ["GET", "POST"].map((method) => ({
  operationId:
    method === "GET" ? "desktop_control_status" : "desktop_control_update",
  endpoint: "desktop/control",
  method,
  policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
  ...(method === "POST" ? { requestBody: request } : {}),
  handler: ({ body }) => {
    if (!isAssistantDesktopEnabled(getConfig())) {
      throw new NotFoundError(
        "Desktop control is not available on this assistant",
      );
    }
    if (method === "GET") {
      return desktopControl.getStatus();
    }
    return request.parse(body).action === "take"
      ? desktopControl.takeControl()
      : desktopControl.allowAssistant();
  },
  summary:
    method === "GET"
      ? "Get desktop control status"
      : "Hand desktop control between the user and assistant",
  tags: ["desktop"],
  responseBody: status,
}));
