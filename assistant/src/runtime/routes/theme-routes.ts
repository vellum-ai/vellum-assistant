import { z } from "zod";

import {
  readWorkspaceTheme,
  WorkspaceThemeSchema,
} from "../../theme/workspace-theme.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

function handleGetWorkspaceTheme() {
  return readWorkspaceTheme();
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "workspace_theme_get",
    endpoint: "workspace/theme",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetWorkspaceTheme,
    summary: "Get workspace theme",
    description:
      "Return validated design-token overrides from the workspace ui/theme.json. " +
      "Absent or rejected files yield theme: null with the rejection reasons in issues; " +
      "clients fall back to built-in theme defaults.",
    tags: ["workspace"],
    responseBody: z.object({
      theme: WorkspaceThemeSchema.nullable(),
      source: z.enum(["workspace", "invalid", "none"]),
      issues: z.array(z.string()),
    }),
  },
];
