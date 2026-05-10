import { getRecentInvocations } from "../../memory/tool-usage-store.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

async function handleAuditRecentInvocations(
  args: RouteHandlerArgs,
): Promise<{ invocations: ReturnType<typeof getRecentInvocations> }> {
  const raw = args.queryParams?.limit ?? "20";
  const limit = parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new BadRequestError("limit must be a positive integer");
  }
  const clampedLimit = Math.min(limit, 500);
  const rows = getRecentInvocations(clampedLimit);
  return { invocations: rows };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "audit_recent_invocations",
    endpoint: "audit/invocations",
    method: "GET",
    summary: "List recent tool invocations",
    tags: ["audit"],
    queryParams: [
      { name: "limit", description: "Max rows (default 20, max 500)" },
    ],
    handler: handleAuditRecentInvocations,
  },
];
