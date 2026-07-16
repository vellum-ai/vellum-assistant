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
import {
  getWireFieldsSchema,
  getWireSchemaForType,
} from "../../telemetry/telemetry-wire-validation.js";
import type {
  ClientReportableTelemetryEventName,
  TelemetryEvent,
} from "../../telemetry/types.js";
import { CLIENT_REPORTABLE_TELEMETRY_EVENT_NAMES } from "../../telemetry/types.js";
import { getUsageTelemetryReporter } from "../../telemetry/usage-telemetry-reporter.js";
import { getLogger } from "../../util/logger.js";
import { APP_VERSION } from "../../version.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("telemetry-routes");

const VALID_EVENT_NAMES = new Set(["app_open", "hatch"]);

const ingestDaemonEventIdSchema = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    "Optional collapse key: rows sharing an id collapse downstream " +
      "(e.g. a retried report). Defaults to a fresh per-row id.",
  );

/**
 * One request variant per client-reportable type: `{ type, fields, daemon_event_id? }`
 * where `fields` is the wire schema for that type minus the daemon-stamped base
 * fields. Throws at module load if a client-reportable name has no wire schema
 * (the allowlist and wire contract drifted).
 */
function buildIngestVariant(name: ClientReportableTelemetryEventName) {
  const fields = getWireFieldsSchema(name);
  if (!fields) {
    throw new Error(
      `No wire schema for client-reportable telemetry type "${name}".`,
    );
  }
  return z.object({
    type: z.literal(name),
    fields: fields.describe(
      "Wire event fields, excluding the daemon-stamped base fields " +
        "(type, daemon_event_id, recorded_at, assistant_version).",
    ),
    daemon_event_id: ingestDaemonEventIdSchema,
  });
}

/**
 * Request shape for `POST /v1/telemetry/ingest`: a discriminated union over the
 * client-reportable event types, each carrying that type's wire `fields`.
 * Derived from the wire contract, so the generated SDK body is strongly typed
 * and stays in sync as the allowlist and wire schemas evolve.
 */
const telemetryIngestRequestSchema = z.discriminatedUnion(
  "type",
  // `.map` widens to `ZodObject[]`, but `discriminatedUnion` wants a non-empty
  // tuple. The allowlist is a non-empty const, and the RUNTIME schema (not this
  // static type) is what codegen introspects, so the cast doesn't affect the
  // emitted OpenAPI/SDK types.
  CLIENT_REPORTABLE_TELEMETRY_EVENT_NAMES.map(buildIngestVariant) as [
    ReturnType<typeof buildIngestVariant>,
    ...ReturnType<typeof buildIngestVariant>[],
  ],
);

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
  return reporter.flush();
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
 *      allowlist and `fields` must match the type's wire shape — both enforced
 *      by the discriminated-union parse, so a client can never inject a
 *      daemon-authoritative type (`turn`, `config_setting`, …) nor a malformed
 *      payload.
 *   2. The assembled event must additionally pass the full wire schema for the
 *      byte-bound superRefines the request `fields` schema drops (oversize
 *      claims/suggestions).
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

  // `type` is allowlisted (the parse matched a union variant), so a wire schema
  // is guaranteed — its absence is an invariant breach, not a client error.
  const wireSchema = getWireSchemaForType(type);
  if (!wireSchema) {
    throw new Error(
      `No wire schema registered for client-reportable type "${type}".`,
    );
  }

  // Re-validate the assembled event against the full wire schema for the
  // byte-bound superRefines the request `fields` schema drops. Up front (with
  // placeholder base values) so an oversize payload 400s regardless of consent.
  // The `.trim()`-transformed parse output is discarded: `fields` are recorded
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
    "conversation_id" in fields && typeof fields.conversation_id === "string"
      ? fields.conversation_id
      : null;

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
      z.object({
        flushed: z.literal(true),
        sent: z.number().describe("Events POSTed to the platform"),
        persisted: z.number().describe("Events the platform confirmed written"),
        dropped: z
          .number()
          .describe("Events that did not land (sent - persisted)"),
      }),
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
