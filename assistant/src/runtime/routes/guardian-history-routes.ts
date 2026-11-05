/**
 * GET /v1/guardian-requests — guardian request history.
 *
 * Returns the guardian's request history from the gateway, ordered
 * newest-first. Supports filtering by status and kind, plus keyset
 * pagination via `limit` + `before` + `beforeId` (composite cursor).
 *
 * Callers check `hasMore` to decide whether to fetch the next page:
 *   GET /v1/guardian-requests?limit=50&before=<last createdAt>&beforeId=<last id>
 */

import {
  GuardianRequestKindSchema,
  GuardianRequestSchema,
  GuardianRequestStatusSchema,
  type GuardianRequestWire,
} from "@vellumai/gateway-client";
import { z } from "zod";

import { listGuardianRequests } from "../../channels/gateway-guardian-requests.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function handleListGuardianRequests({
  queryParams = {},
}: RouteHandlerArgs): Promise<{
  requests: GuardianRequestWire[];
  hasMore: boolean;
}> {
  const rawLimit = queryParams.limit;
  const rawBefore = queryParams.before;
  const rawBeforeId = queryParams.beforeId;
  const rawStatus = queryParams.status;
  const rawKind = queryParams.kind;

  const limit = rawLimit !== undefined ? Number(rawLimit) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequestError(
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
  }

  const before = rawBefore !== undefined ? Number(rawBefore) : undefined;
  if (before !== undefined && (!Number.isFinite(before) || before <= 0)) {
    throw new BadRequestError("before must be a positive epoch-ms timestamp");
  }

  const beforeId = rawBeforeId !== undefined ? String(rawBeforeId) : undefined;

  const statusResult =
    rawStatus !== undefined
      ? GuardianRequestStatusSchema.safeParse(rawStatus)
      : null;
  if (statusResult && !statusResult.success) {
    throw new BadRequestError(
      `status must be one of: ${GuardianRequestStatusSchema.options.join(", ")}`,
    );
  }

  const kindResult =
    rawKind !== undefined ? GuardianRequestKindSchema.safeParse(rawKind) : null;
  if (kindResult && !kindResult.success) {
    throw new BadRequestError(
      `kind must be one of: ${GuardianRequestKindSchema.options.join(", ")}`,
    );
  }

  // Fetch one extra row to detect whether there are more pages.
  const fetchLimit = limit + 1;

  const rows = await listGuardianRequests({
    ...(statusResult ? { status: statusResult.data } : {}),
    ...(kindResult ? { kind: kindResult.data } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(beforeId !== undefined ? { beforeId } : {}),
    limit: fetchLimit,
  });

  const hasMore = rows.length > limit;
  const requests = hasMore ? rows.slice(0, limit) : rows;

  return { requests, hasMore };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "guardian_requests_list_history",
    endpoint: "guardian-requests",
    method: "GET",
    policy: {
      requiredScopes: ["approval.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    requireGuardian: true,
    summary: "List guardian request history",
    description:
      "Returns guardian requests ordered newest-first (createdAt DESC, id ASC). Supports filtering by status and kind, and keyset pagination via limit + before + beforeId.",
    tags: ["guardian"],
    queryParams: [
      {
        name: "status",
        schema: {
          type: "string",
          enum: [...GuardianRequestStatusSchema.options],
        },
        description: "Filter by request status",
      },
      {
        name: "kind",
        schema: {
          type: "string",
          enum: [...GuardianRequestKindSchema.options],
        },
        description: "Filter by request kind",
      },
      {
        name: "limit",
        schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        description: `Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
      },
      {
        name: "before",
        schema: { type: "number" },
        description:
          "Keyset cursor: epoch-ms createdAt of the last item from the previous page",
      },
      {
        name: "beforeId",
        schema: { type: "string" },
        description:
          "Keyset cursor: id of the last item from the previous page (required when before is set, for correct pagination when multiple items share the same createdAt)",
      },
    ],
    responseBody: z.object({
      requests: z
        .array(GuardianRequestSchema)
        .describe("Guardian request objects"),
      hasMore: z
        .boolean()
        .describe("True when more pages exist beyond this result set"),
    }),
    handler: handleListGuardianRequests,
  },
];
