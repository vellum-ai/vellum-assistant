/**
 * Route for programmatically scheduling the onboarding "Day 2 Check-in".
 *
 * POST /v1/onboarding/checkin — resolve the user's Google Calendar, find the
 * first open 15-minute slot tomorrow afternoon, and book the check-in event.
 *
 * Called by the web `/onboarding/research` flow the moment Google Calendar
 * OAuth lands. Best-effort by contract: a missing/insufficient calendar
 * connection returns `{ scheduled: false }` rather than an error.
 */

import { z } from "zod";

import { scheduleOnboardingCheckin } from "../../onboarding/schedule-checkin.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("onboarding-checkin-routes");

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new BadRequestError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function handleScheduleOnboardingCheckin({
  body = {},
}: RouteHandlerArgs) {
  // The shared route adapter does not runtime-validate the body against the
  // Zod requestBody (codegen-only), so guard types before use.
  const userName = asOptionalString(body.userName, "userName");
  const assistantName = asOptionalString(body.assistantName, "assistantName");
  const timeZone = asOptionalString(body.timezone, "timezone");

  const result = await scheduleOnboardingCheckin({
    userName,
    assistantName,
    timeZone,
  });

  if (!result.scheduled) {
    log.info({ reason: result.reason }, "Onboarding check-in not scheduled");
  }
  return result;
}

const RESPONSE_SCHEMA = z.object({
  scheduled: z.boolean(),
  reason: z.string().optional(),
  eventId: z.string().optional(),
  htmlLink: z.string().nullable().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  timeZone: z.string().optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "scheduleOnboardingCheckin",
    endpoint: "onboarding/checkin",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Schedule the onboarding Day 2 check-in",
    description:
      "Find the first open 15-minute slot between 12pm and 5pm tomorrow " +
      "(widening to 8am–8pm if booked) on the user's Google Calendar and " +
      "create the Day 2 Check-in event. Best-effort: returns scheduled=false " +
      "when no calendar is connected or the calendar scope wasn't granted.",
    tags: ["onboarding"],
    requestBody: z.object({
      userName: z.string().optional(),
      assistantName: z.string().optional(),
      timezone: z.string().optional(),
    }),
    responseBody: RESPONSE_SCHEMA,
    handler: handleScheduleOnboardingCheckin,
  },
];
