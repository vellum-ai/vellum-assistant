import { z } from "zod";

import { DESKTOP_APPS, desktopAppManager } from "../../desktop/desktop-apps.js";
import { desktopAutomationLease } from "../../desktop/desktop-automation-lease.js";
import { desktopDependencyInstaller } from "../../desktop/desktop-dependencies.js";
import { getDesktopSessionManager } from "../../desktop/desktop-session-manager.js";
import { isVirtualDesktopEnabled } from "../../desktop/virtual-desktop-feature.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
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

const appIdSchema = z.enum(DESKTOP_APPS.map((app) => app.id));

const appRequestSchema = z
  .object({
    appId: appIdSchema,
    action: z.enum(["add", "open"]),
  })
  .strict();
const appsSchema = z.object({
  apps: z.array(
    z.object({
      id: appIdSchema,
      state: z.enum([
        "available",
        "installed",
        "added",
        "installing",
        "failed",
      ]),
    }),
  ),
});

ROUTES.push(
  ...["GET", "POST"].map(
    (method): RouteDefinition => ({
      operationId:
        method === "GET" ? "desktop_apps_list" : "desktop_apps_action",
      endpoint: "desktop/apps",
      method,
      policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
      requestBody: method === "POST" ? appRequestSchema : undefined,
      responseBody: appsSchema,
      summary:
        method === "GET" ? "List desktop apps" : "Add or open a desktop app",
      tags: ["desktop"],
      handler: async ({ body }) => {
        if (!isVirtualDesktopEnabled()) {
          throw new NotFoundError("Desktop is not available on this assistant");
        }
        if (method === "POST") {
          const parsed = appRequestSchema.safeParse(body);
          if (!parsed.success) {
            throw new BadRequestError(
              "Choose an available desktop app and action",
            );
          }
          if (desktopDependencyInstaller.getStatus().state !== "ready") {
            throw new ConflictError("Finish desktop setup before adding apps");
          }
          const app = DESKTOP_APPS.find(
            (entry) => entry.id === parsed.data.appId,
          )!;
          if (parsed.data.action === "add") {
            desktopAppManager.add(app);
          } else {
            if (
              desktopAppManager.list().find((entry) => entry.id === app.id)
                ?.state !== "added"
            ) {
              throw new ConflictError("Add the app before opening it");
            }
            try {
              await getDesktopSessionManager().openApplication(app);
            } catch {
              throw new ConflictError(
                "The app could not open. Connect to the desktop and try again",
              );
            }
          }
        }
        return { apps: desktopAppManager.list() };
      },
    }),
  ),
);
