import { z } from "zod";

import { desktopAutomationLease } from "../../desktop/desktop-automation-lease.js";
import { desktopDependencies } from "../../desktop/desktop-dependencies.js";
import { isVirtualDesktopEnabled } from "../../desktop/virtual-desktop-feature.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const statusSchema = z.object({
  state: z.enum(["required", "installing", "ready", "failed", "unsupported"]),
  automationActive: z.boolean().optional(),
  stage: z.enum(["packages", "chrome", "checking"]).optional(),
});

// POST and its wire schema support released clients; both methods only read readiness.
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
    const status = desktopDependencies.getStatus();
    return { ...status, automationActive: desktopAutomationLease.isActive };
  },
  summary:
    method === "GET"
      ? "Get virtual desktop setup status"
      : "Check virtual desktop readiness (legacy POST)",
  tags: ["desktop"],
  responseBody: statusSchema,
}));
