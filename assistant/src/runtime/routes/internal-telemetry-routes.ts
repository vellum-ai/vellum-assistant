/**
 * Internal telemetry routes — receive operational signals forwarded from the
 * gateway over the internal (service-token) transport.
 *
 * POST /v1/internal/telemetry/auth-fallback — record aggregated counts of
 * requests served via the legacy loopback auth fallback. The gateway counts
 * fallbacks in memory and flushes them here per window; the usage telemetry
 * reporter ships the persisted rows to the platform.
 *
 * POST /v1/internal/telemetry/watchdog — relay a gateway-origin watchdog
 * event straight to platform ingest via the direct (unbuffered) emit path,
 * bypassing the SQLite watchdog buffer. Used for integrity alarms (e.g.
 * `gateway_guardian_missing`) that must not depend on the state they report
 * on. Consent/platform gating happens inside the direct emit.
 */

import { z } from "zod";

import {
  type AuthFallbackCount,
  recordAuthFallbackCounts,
} from "../../security/auth-fallback-events-store.js";
import { emitWatchdogEventDirect } from "../../telemetry/watchdog-direct-emit.js";
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
    // Counts dropped: share_analytics consent is off (honoring the opt-out)
    // or the telemetry database is unavailable (degraded mode).
    return { skipped: true };
  }
  log.debug({ recorded }, "Recorded auth-fallback counts");
  return { recorded };
}

const watchdogRelayBody = z.object({
  check_name: z.string().min(1).max(128),
  detail: z.record(z.string(), z.unknown()).nullable().optional(),
  value: z.number().nullable().optional(),
});

async function handleRelayWatchdogEvent({ body }: RouteHandlerArgs) {
  const parsed = watchdogRelayBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid watchdog payload: ${parsed.error.message}`,
    );
  }
  const { check_name, detail, value } = parsed.data;
  // Never throws; opt-out and platform gates are enforced inside.
  await emitWatchdogEventDirect(check_name, detail ?? null, value ?? null);
  return { ok: true as const };
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
  {
    operationId: "internal_telemetry_watchdog",
    endpoint: "internal/telemetry/watchdog",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Relay a watchdog telemetry event",
    description:
      "Emits a gateway-origin watchdog telemetry event directly to platform " +
      "ingest, bypassing the SQLite watchdog buffer, so integrity alarms " +
      "never depend on the state they report on.",
    tags: ["internal", "telemetry"],
    requestBody: watchdogRelayBody,
    responseBody: z.object({ ok: z.literal(true) }),
    handler: handleRelayWatchdogEvent,
  },
];
