import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { desktopDependencyInstaller } from "../../desktop/desktop-dependencies.js";
import { isAssistantDesktopEnabled } from "../../desktop/desktop-feature.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const statusSchema = z.object({
  state: z.enum(["required", "installing", "ready", "failed", "unsupported"]),
  stage: z.enum(["packages", "chrome", "checking"]).optional(),
});

export const ROUTES: RouteDefinition[] = ["GET", "POST"].map((method) => ({
  operationId:
    method === "GET" ? "desktop_setup_status" : "desktop_setup_install",
  endpoint: "desktop/setup",
  method,
  policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
  handler: () => {
    if (!isAssistantDesktopEnabled(getConfig())) {
      throw new NotFoundError("Desktop is not available on this assistant");
    }
    return method === "GET"
      ? desktopDependencyInstaller.getStatus()
      : desktopDependencyInstaller.start();
  },
  summary:
    method === "GET"
      ? "Get desktop setup status"
      : "Install desktop components",
  tags: ["desktop"],
  responseBody: statusSchema,
}));
