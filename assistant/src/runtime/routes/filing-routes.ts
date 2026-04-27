/**
 * Route handlers for filing management.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { FilingService } from "../../filing/filing-service.js";
import { getLogger } from "../../util/logger.js";
import { InternalError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("filing-routes");

// ---------------------------------------------------------------------------
// Shared ROUTES
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getFilingConfig",
    endpoint: "filing/config",
    method: "GET",
    policyKey: "filing",
    requirePolicyEnforcement: true,
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
    handler: async (_args: RouteHandlerArgs) => {
      const config = getConfig().filing;
      const svc = FilingService.getInstance();
      return {
        enabled: config.enabled,
        intervalMs: config.intervalMs,
        activeHoursStart: config.activeHoursStart ?? null,
        activeHoursEnd: config.activeHoursEnd ?? null,
        nextRunAt: svc?.nextRunAt ?? null,
        lastRunAt: svc?.lastRunAt ?? null,
        success: true,
      };
    },
  },
  {
    operationId: "runFilingNow",
    endpoint: "filing/run-now",
    method: "POST",
    policyKey: "filing",
    requirePolicyEnforcement: true,
    summary: "Run filing now",
    description: "Trigger an immediate filing run.",
    tags: ["filing"],
    responseBody: z.object({
      success: z.boolean(),
      ran: z.boolean().describe("Whether the filing actually ran"),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      const svc = FilingService.getInstance();
      if (!svc) {
        throw new InternalError("Filing service not available");
      }
      try {
        const ran = await svc.runOnce({ force: true });
        return { success: true, ran };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, "Filing run-now failed");
        return { success: false, ran: false, error: message };
      }
    },
  },
];
