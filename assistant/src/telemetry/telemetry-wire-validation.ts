/**
 * Pre-flush validation of outgoing telemetry events against the
 * platform-generated wire schemas (`telemetry-wire.generated.ts`).
 *
 * The platform ingest endpoint rejects individual events that violate its
 * serializer bounds and skips event types it has no serializer for — both
 * silently from the daemon's point of view (the batch still 2xxes). This
 * module surfaces those would-be-silent drops as structured warnings at the
 * source, right before each POST.
 *
 * Observability only: validation never mutates, filters, or blocks a batch.
 * The server remains the authority on what it accepts; in particular the
 * `.trim()`-transformed parse output is never substituted for the original
 * events.
 */

import type { z } from "zod";

import type { getLogger } from "../util/logger.js";
import { telemetryEventSchema } from "./telemetry-wire.generated.js";

type Logger = ReturnType<typeof getLogger>;

/**
 * Per-event-type wire schema, derived by introspecting the generated
 * discriminated union (`.options` + each member's `type` literal), so a new
 * generated event type is validated with zero hand edits here.
 */
export const wireSchemaByType: ReadonlyMap<string, z.ZodType> = new Map(
  telemetryEventSchema.options.map((option) => [
    option.shape.type.value,
    option,
  ]),
);

/**
 * Event types already warned about as absent from the wire contract.
 * Unknown-type warnings are rate-limited to once per process per type —
 * without this, a daemon-only extension type (e.g. `onboarding_research`)
 * would warn on every 5-minute flush forever.
 */
const warnedUnknownTypes = new Set<string>();

/** Clears the once-per-process unknown-type warning rate limit. Test-only. */
export function resetUnknownTypeWarningsForTests(): void {
  warnedUnknownTypes.clear();
}

/**
 * Render a zod issue path for logging without leaking dynamic record keys.
 *
 * Rule: keep numeric components (array indices — structural, never data) and
 * keep the first (depth-0) component; redact every deeper string component to
 * a literal `*`. Depth-0 is safe because every generated event schema is a
 * flat `z.object`, so top-level path components are schema-defined field
 * names. Deeper string components can be dynamic record keys — e.g. the turn
 * schema's `client` bag superRefine emits issues at `['client', <key>]` where
 * `<key>` comes from an uncontrolled JSON metadata column and could carry
 * user text.
 */
function sanitizeIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((component, depth) =>
      typeof component === "number" || depth === 0 ? String(component) : "*",
    )
    .join(".");
}

export interface WireValidationResult {
  /** Events whose type had a wire schema and were parsed against it. */
  checked: number;
  /** Checked events that failed their wire schema. */
  invalid: number;
  /** Distinct event types with no wire schema — the server drops these. */
  unknownTypes: string[];
}

/**
 * Validate a batch of outgoing telemetry events against the platform wire
 * schemas, logging a structured warning for each event the server would
 * silently drop. Warn payloads carry the event `type` and issue
 * `{ path, code }` shapes only — never field values, and never dynamic key
 * components inside paths (see {@link sanitizeIssuePath}). That includes
 * `daemon_event_id`: traces/claims can hold PII, and activation-funnel ids
 * embed the onboarding session id.
 *
 * Never mutates, filters, or blocks: callers send the batch unchanged
 * regardless of the result.
 */
export function validateWireEvents(
  events: readonly { type: string }[],
  log: Logger,
): WireValidationResult {
  let checked = 0;
  let invalid = 0;
  const unknownTypes = new Set<string>();
  for (const event of events) {
    const schema = wireSchemaByType.get(event.type);
    if (!schema) {
      unknownTypes.add(event.type);
      if (!warnedUnknownTypes.has(event.type)) {
        warnedUnknownTypes.add(event.type);
        log.warn(
          { eventType: event.type },
          "telemetry event type not in platform wire contract — server drops these; see telemetry-wire.generated.ts",
        );
      }
      continue;
    }
    checked += 1;
    const result = schema.safeParse(event);
    if (!result.success) {
      invalid += 1;
      const issues = result.error.issues.map((issue) => ({
        path: sanitizeIssuePath(issue.path),
        code: issue.code,
      }));
      log.warn(
        { eventType: event.type, issues },
        "telemetry event fails platform wire contract — server will silently drop it",
      );
    }
  }
  return { checked, invalid, unknownTypes: [...unknownTypes] };
}
