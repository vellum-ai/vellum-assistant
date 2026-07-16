/**
 * Route handlers for telemetry lifecycle events.
 *
 * POST /v1/telemetry/lifecycle — record a lifecycle event (app_open, hatch).
 * POST /v1/telemetry/ingest — record any client-reportable outbox-backed
 * telemetry event by its wire `type` + `fields`.
 */

import { z } from "zod";

import { recordLifecycleEvent } from "../../persistence/lifecycle-events-store.js";
import { recordTelemetryOutboxEvent } from "../../telemetry/telemetry-events-outbox.js";
import { getWireSchemaForType } from "../../telemetry/telemetry-wire-validation.js";
import {
  CLIENT_REPORTABLE_TELEMETRY_EVENT_NAMES,
  isClientReportableTelemetryEventName,
} from "../../telemetry/types.js";
import type { TelemetryEvent } from "../../telemetry/types.js";
import { getUsageTelemetryReporter } from "../../telemetry/usage-telemetry-reporter.js";
import { getLogger } from "../../util/logger.js";
import { APP_VERSION } from "../../version.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("telemetry-routes");

const VALID_EVENT_NAMES = new Set(["app_open", "hatch"]);

/**
 * Request shape for `POST /v1/telemetry/ingest`. `fields` carries every wire
 * field EXCEPT the daemon-stamped base fields (`type`, `daemon_event_id`,
 * `recorded_at`, `assistant_version`); the handler assembles the full event and
 * validates it against the wire schema for `type`.
 */
const telemetryIngestRequestSchema = z.object({
  type: z
    .string()
    .describe("Wire event type; must be a client-reportable telemetry event."),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      "Wire event fields, excluding the daemon-stamped base fields " +
        "(type, daemon_event_id, recorded_at, assistant_version).",
    ),
  daemon_event_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Optional collapse key: rows sharing an id collapse downstream " +
        "(e.g. a retried report). Defaults to a fresh per-row id.",
    ),
});

/** Placeholder id satisfying the wire schema's `daemon_event_id` bound during
 * the up-front validation pass; the real id is stamped at record time. */
const VALIDATION_PROBE_DAEMON_EVENT_ID = "validation-probe";

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

/**
 * Record any client-reportable outbox-backed telemetry event.
 *
 * Client-orchestrated events are ones the daemon can't observe on its own —
 * only the client knows when they happened and what they produced (today just
 * `onboarding_research`). This is the generic bridge that exposes the daemon's
 * in-process `recordTelemetryEvent` recorder to clients over HTTP/IPC.
 *
 * Three guarantees before a row lands:
 *   1. `type` must be on the {@link CLIENT_REPORTABLE_TELEMETRY_EVENT_NAMES}
 *      allowlist — a client can never inject a daemon-authoritative type
 *      (`turn`, `config_setting`, …) and corrupt the event stream.
 *   2. The assembled event (base fields stamped) must pass the platform wire
 *      schema for `type` — a malformed payload 400s here instead of being
 *      silently dropped at flush.
 *   3. Consent is enforced by {@link recordTelemetryOutboxEvent} (the
 *      `share_analytics` gate), same as every daemon-internal emitter.
 *
 * An optional `daemon_event_id` lets the client supply a collapse key (e.g. a
 * refresh-retried report reusing a conversation-scoped id); it defaults to the
 * fresh row id. A `conversation_id` field on the event is threaded into the
 * outbox row's dedicated column so pending rows redact on conversation deletion
 * via the indexed delete.
 */
function handleTelemetryIngest({ body }: RouteHandlerArgs) {
  const parsed = telemetryIngestRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.message);
  }
  const { type, fields, daemon_event_id: daemonEventId } = parsed.data;

  if (!isClientReportableTelemetryEventName(type)) {
    throw new BadRequestError(
      `type must be one of: ${CLIENT_REPORTABLE_TELEMETRY_EVENT_NAMES.join(", ")}`,
    );
  }

  // Every client-reportable type is in the wire contract, so a schema is
  // guaranteed; guard rather than assert.
  const wireSchema = getWireSchemaForType(type);
  if (!wireSchema) {
    throw new BadRequestError(`No wire schema registered for type "${type}".`);
  }

  // Validate the assembled event up front (with placeholder base values) so a
  // malformed payload 400s regardless of consent — the record path below
  // short-circuits on an opt-out before it would otherwise validate. The
  // `.trim()`-transformed parse output is discarded: `fields` are recorded
  // verbatim, matching pre-flush validation's non-mutating contract.
  const validation = wireSchema.safeParse({
    ...fields,
    type,
    daemon_event_id: daemonEventId ?? VALIDATION_PROBE_DAEMON_EVENT_ID,
    recorded_at: 0,
    assistant_version: APP_VERSION,
  });
  if (!validation.success) {
    throw new BadRequestError(validation.error.message);
  }

  const conversationId =
    typeof fields.conversation_id === "string" ? fields.conversation_id : null;

  const event = recordTelemetryOutboxEvent(
    type,
    (id, createdAt): TelemetryEvent =>
      // Base fields stamped after the spread so a `fields` payload carrying a
      // base key can never override the daemon's stamp.
      ({
        ...fields,
        type,
        daemon_event_id: daemonEventId ?? id,
        recorded_at: createdAt,
        assistant_version: APP_VERSION,
      }) as TelemetryEvent,
    { conversationId },
  );
  if (!event) {
    return { skipped: true };
  }
  log.info({ type, eventId: event.id }, "Recorded client telemetry event");

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
    operationId: "telemetry_ingest",
    endpoint: "telemetry/ingest",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Record a client-reportable telemetry event",
    description:
      "Record any client-reportable outbox-backed telemetry event by its wire `type` + `fields`. Client-orchestrated: for events the daemon can't observe on its own (e.g. onboarding_research). The type must be on the daemon's client-reportable allowlist and the payload must pass the platform wire schema. Gated on share_analytics consent like every other outbox-backed event; the platform re-checks the owner's consent server-side at ingest.",
    tags: ["telemetry"],
    requestBody: telemetryIngestRequestSchema,
    responseBody: z.union([
      z.object({ id: z.string().describe("Event ID") }),
      z.object({
        skipped: z
          .literal(true)
          .describe(
            "Event skipped: usage data collection is disabled or the telemetry database is unavailable",
          ),
      }),
    ]),
    handler: handleTelemetryIngest,
  },
];
