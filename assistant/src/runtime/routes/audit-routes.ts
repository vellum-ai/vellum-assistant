/**
 * Route handlers for tool invocation audit log.
 *
 * GET /v1/audit?limit=20 — list recent tool invocations
 */

import { z } from "zod";

import { getRecentInvocations } from "../../memory/tool-usage-store.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function handleAuditList({ queryParams }: RouteHandlerArgs) {
  const limitRaw = queryParams?.limit;
  const limit =
    limitRaw !== undefined ? parseInt(limitRaw, 10) : 20;
  const invocations = getRecentInvocations(
    Number.isFinite(limit) && limit > 0 ? limit : 20,
  );
  return { invocations };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "audit_list",
    endpoint: "audit",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "List recent tool invocations",
    description:
      "Returns recent tool invocation records from the audit log, ordered by most recent first.",
    tags: ["audit"],
    queryParams: [
      {
        name: "limit",
        type: "integer",
        description: "Maximum number of entries to return (default 20)",
      },
    ],
    responseBody: z.object({
      invocations: z.array(z.unknown()).describe("Tool invocation records"),
    }),
    handler: handleAuditList,
  },
];
