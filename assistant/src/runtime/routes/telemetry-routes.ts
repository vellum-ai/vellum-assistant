/**
 * Route handlers for telemetry lifecycle events.
 *
 * POST /v1/telemetry/lifecycle — record a lifecycle event (app_open, hatch).
 * POST /v1/telemetry/onboarding-research — record the settled result of an
 * onboarding "research me" web-search turn.
 */

import { z } from "zod";

import { recordOnboardingResearchEvent } from "../../onboarding/onboarding-research-events-store.js";
import { recordLifecycleEvent } from "../../persistence/lifecycle-events-store.js";
import { getUsageTelemetryReporter } from "../../telemetry/usage-telemetry-reporter.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("telemetry-routes");

const VALID_EVENT_NAMES = new Set(["app_open", "hatch"]);

const onboardingResearchClaimSchema = z.object({
  claim: z.string(),
  confidence: z.enum(["confident", "maybe", "guessing"]),
  sources: z.array(z.string()),
});

const onboardingResearchSuggestionSchema = z.object({
  suggestion: z.string(),
  prompt: z.string(),
});

const onboardingResearchRequestSchema = z.object({
  conversation_id: z.string().nullable(),
  status: z.enum(["done", "error"]),
  claims: z.array(onboardingResearchClaimSchema),
  suggestions: z.array(onboardingResearchSuggestionSchema),
  plugins: z.array(z.string()),
  installed_plugins: z.array(z.string()),
});

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

async function handleTelemetryFlush() {
  const reporter = getUsageTelemetryReporter();
  if (!reporter) {
    return { flushed: false, reason: "disabled" };
  }
  await reporter.flush();
  return { flushed: true };
}

function handleRecordOnboardingResearchEvent({ body }: RouteHandlerArgs) {
  const parsed = onboardingResearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.message);
  }

  const event = recordOnboardingResearchEvent({
    conversationId: parsed.data.conversation_id,
    status: parsed.data.status,
    claims: parsed.data.claims,
    suggestions: parsed.data.suggestions,
    plugins: parsed.data.plugins,
    installedPlugins: parsed.data.installed_plugins,
  });
  if (!event) {
    return { skipped: true };
  }
  log.info(
    { eventId: event.id, claimCount: parsed.data.claims.length },
    "Recorded onboarding-research event",
  );

  return { id: event.id };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "telemetry_lifecycle",
    endpoint: "telemetry/lifecycle",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
  {
    operationId: "telemetry_flush",
    endpoint: "telemetry/flush",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Flush pending telemetry events",
    description:
      "Force-flush the telemetry events owned by the assistant process (turn events) to the platform. Other event types are flushed on their own cycle by the resource monitor process.",
    tags: ["telemetry"],
    responseBody: z.union([
      z.object({ flushed: z.literal(true) }),
      z.object({
        flushed: z.literal(false),
        reason: z.string(),
      }),
    ]),
    handler: handleTelemetryFlush,
  },
  {
    operationId: "telemetry_onboarding_research",
    endpoint: "telemetry/onboarding-research",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Record onboarding-research event",
    description:
      "Record the settled result of an onboarding \"research me\" web-search turn (claims, suggestions, and plugin picks). Client-orchestrated: the web client reports this once it has observed the turn complete.",
    tags: ["telemetry"],
    requestBody: onboardingResearchRequestSchema,
    responseBody: z.union([
      z.object({ id: z.string().describe("Event ID") }),
      z.object({
        skipped: z
          .literal(true)
          .describe(
            "Event skipped due to usage data collection being disabled",
          ),
      }),
    ]),
    handler: handleRecordOnboardingResearchEvent,
  },
];
