/**
 * Route handlers for telemetry lifecycle events.
 *
 * POST /v1/telemetry/lifecycle — record a lifecycle event (app_open, hatch).
 */

import { z } from "zod";

import { recordLifecycleEvent } from "../../memory/lifecycle-events-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("telemetry-routes");

const VALID_EVENT_NAMES = new Set(["app_open", "hatch"]);

async function handleRecordLifecycleEvent(req: Request): Promise<Response> {
  let body: { event_name?: string };
  try {
    body = (await req.json()) as { event_name?: string };
  } catch {
    return httpError("BAD_REQUEST", "Invalid JSON body", 400);
  }

  const eventName = body.event_name;
  if (!eventName || !VALID_EVENT_NAMES.has(eventName)) {
    return httpError(
      "BAD_REQUEST",
      `event_name must be one of: ${[...VALID_EVENT_NAMES].join(", ")}`,
      400,
    );
  }

  const event = recordLifecycleEvent(eventName);
  if (!event) {
    return Response.json({ skipped: true });
  }
  log.info({ eventName, eventId: event.id }, "Recorded lifecycle event");

  return Response.json({ id: event.id, event_name: event.eventName });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function telemetryRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "telemetry/lifecycle",
      method: "POST",
      summary: "Record lifecycle event",
      description: "Record a telemetry lifecycle event (app_open, hatch).",
      tags: ["telemetry"],
      requestBody: z.object({
        event_name: z.string().describe("Event name: app_open or hatch"),
      }),
      responseBody: z.union([
        z.object({
          id: z.string().describe("Event ID"),
          event_name: z.string(),
        }),
        z.object({
          skipped: z
            .literal(true)
            .describe(
              "Event skipped due to usage data collection being disabled",
            ),
        }),
      ]),
      handler: async ({ req }) => handleRecordLifecycleEvent(req),
    },
  ];
}
