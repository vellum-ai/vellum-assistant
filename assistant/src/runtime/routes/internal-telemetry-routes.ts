/**
 * Internal telemetry routes — receive operational signals forwarded from the
 * gateway over the internal (service-token) transport.
 *
 * POST /v1/internal/telemetry/auth-fallback — record aggregated counts of
 * requests served via the legacy loopback auth fallback. The gateway counts
 * fallbacks in memory and flushes them here per window; the usage telemetry
 * reporter ships the persisted rows to the platform.
 */

import { z } from "zod";

import {
  type AuthFallbackCount,
  recordAuthFallbackCounts,
} from "../../security/auth-fallback-events-store.js";
import { getLogger } from "../../util/logger.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("internal-telemetry-routes");

const authFallbackBody = z.object({
  window_start: z.number().int().nonnegative(),
  window_end: z.number().int().nonnegative(),
  counts: z
    .array(
      z.object({
        guard: z.string().min(1),
        path: z.string().min(1),
        failure_kind: z.string().min(1),
        count: z.number().int().positive(),
      }),
    )
    .min(1),
});

function handleRecordAuthFallback({ body }: RouteHandlerArgs) {
  const parsed = authFallbackBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid auth-fallback payload: ${parsed.error.message}`,
    );
  }
  const { window_start, window_end, counts } = parsed.data;
  const mapped: AuthFallbackCount[] = counts.map((c) => ({
    guard: c.guard,
    path: c.path,
    failureKind: c.failure_kind,
    count: c.count,
  }));

  const recorded = recordAuthFallbackCounts(window_start, window_end, mapped);
  if (recorded === 0) {
    // share_analytics consent off — counts dropped to honor the opt-out.
    return { skipped: true };
  }
  log.debug({ recorded }, "Recorded auth-fallback counts");
  return { recorded };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_telemetry_auth_fallback",
    endpoint: "internal/telemetry/auth-fallback",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Record auth-fallback counts",
    description:
      "Receives aggregated legacy-loopback auth-fallback counts forwarded by " +
      "the gateway and persists them for telemetry reporting.",
    tags: ["internal", "telemetry"],
    requestBody: authFallbackBody,
    responseBody: z.union([
      z.object({ recorded: z.number().int().nonnegative() }),
      z.object({
        skipped: z
          .literal(true)
          .describe("Counts dropped because usage data collection is disabled"),
      }),
    ]),
    handler: handleRecordAuthFallback,
  },
];
