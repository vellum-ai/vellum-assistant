/**
 * HTTP route handlers for filing management.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import type { FilingService } from "../../filing/filing-service.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("filing-routes");

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGetConfig(filingService?: FilingService): Response {
  const config = getConfig().filing;
  return Response.json({
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    activeHoursStart: config.activeHoursStart ?? null,
    activeHoursEnd: config.activeHoursEnd ?? null,
    nextRunAt: filingService?.nextRunAt ?? null,
    lastRunAt: filingService?.lastRunAt ?? null,
    success: true,
  });
}

async function handleRunNow(
  filingService?: FilingService,
): Promise<Response> {
  if (!filingService) {
    return httpError(
      "SERVICE_UNAVAILABLE",
      "Filing service not available",
      503,
    );
  }

  try {
    const ran = await filingService.runOnce({ force: true });
    return Response.json({ success: true, ran });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Filing run-now failed");
    return Response.json({ success: false, ran: false, error: message });
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function filingRouteDefinitions(deps: {
  getFilingService?: () => FilingService | undefined;
}): RouteDefinition[] {
  return [
    {
      endpoint: "filing/config",
      method: "GET",
      policyKey: "filing",
      summary: "Get filing config",
      description: "Return the current filing schedule configuration.",
      tags: ["filing"],
      responseBody: z.object({
        enabled: z.boolean(),
        intervalMs: z.number(),
        activeHoursStart: z.number().nullable(),
        activeHoursEnd: z.number().nullable(),
        nextRunAt: z.number().nullable(),
        lastRunAt: z.number().nullable(),
        success: z.boolean(),
      }),
      handler: () => handleGetConfig(deps.getFilingService?.()),
    },
    {
      endpoint: "filing/run-now",
      method: "POST",
      policyKey: "filing",
      summary: "Run filing now",
      description: "Trigger an immediate filing run.",
      tags: ["filing"],
      responseBody: z.object({
        success: z.boolean(),
        ran: z.boolean().describe("Whether the filing actually ran"),
      }),
      handler: () => handleRunNow(deps.getFilingService?.()),
    },
  ];
}
