import { ResourcePressureStatusResponseSchema } from "../../api/responses/resource-pressure-status.js";
import { getResourcePressureStatus } from "../../daemon/resource-pressure-guard.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getResourcePressureStatus",
    endpoint: "resource-pressure/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get resource pressure status",
    description:
      "Return the current resource pressure status snapshot. Off-platform the guard does not run, so a disabled status is returned.",
    tags: ["resource-pressure"],
    responseBody: ResourcePressureStatusResponseSchema,
    handler: () => ({ status: getResourcePressureStatus() }),
  },
];
