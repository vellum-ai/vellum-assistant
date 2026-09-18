import { z } from "zod";

import { desktopAutomationLease } from "../../desktop/desktop-automation-lease.js";
import { desktopDependencyInstaller } from "../../desktop/desktop-dependencies.js";
import { isVirtualDesktopEnabled } from "../../desktop/virtual-desktop-feature.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const statusSchema = z.object({
  state: z.enum(["required", "installing", "ready", "failed", "unsupported"]),
  automationActive: z.boolean().optional(),
  stage: z.enum(["packages", "chrome", "checking"]).optional(),
});

export const ROUTES: RouteDefinition[] = ["GET", "POST"].map((method) => ({
  operationId:
    method === "GET" ? "desktop_setup_status" : "desktop_setup_install",
  endpoint: "desktop/setup",
  method,
  policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
  handler: () => {
    if (!isVirtualDesktopEnabled()) {
      throw new NotFoundError(
        "Virtual desktop is available only on enabled platform-hosted assistants",
      );
    }
    const status =
      method === "GET"
        ? desktopDependencyInstaller.getStatus()
        : desktopDependencyInstaller.start();
    return { ...status, automationActive: desktopAutomationLease.isActive };
  },
  summary:
    method === "GET"
      ? "Get virtual desktop setup status"
      : "Install virtual desktop components",
  tags: ["desktop"],
  responseBody: statusSchema,
}));
