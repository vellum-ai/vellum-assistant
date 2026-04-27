/**
 * Route handlers for telemetry lifecycle events.
 *
 * POST /v1/telemetry/lifecycle — record a lifecycle event (app_open, hatch).
 */

import { z } from "zod";

import { recordLifecycleEvent } from "../../memory/lifecycle-events-store.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("telemetry-routes");

const VALID_EVENT_NAMES = new Set(["app_open", "hatch"]);

function handleRecordLifecycleEvent({ body }: RouteHandlerArgs) {
  const eventName = body?.event_name as string | undefined;
  if (!eventName || !VALID_EVENT_NAMES.has(eventName)) {
    throw new BadRequestError(
      `event_name must be one of: ${[...VALID_EVENT_NAMES].join(", ")}`,
    );
  }

  const event = recordLifecycleEvent(eventName);
  if (!event) {
    return { skipped: true };
  }
  log.info({ eventName, eventId: event.id }, "Recorded lifecycle event");

  return { id: event.id, event_name: event.eventName };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "telemetry_lifecycle",
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
    handler: handleRecordLifecycleEvent,
  },
];
