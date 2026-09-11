import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { DESKTOP_APPS, desktopAppManager } from "../../desktop/desktop-apps.js";
import { desktopDependencyInstaller } from "../../desktop/desktop-dependencies.js";
import { isAssistantDesktopEnabled } from "../../desktop/desktop-feature.js";
import { getDesktopSessionManager } from "../../desktop/desktop-session-manager.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
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
        if (!isAssistantDesktopEnabled(getConfig())) {
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
