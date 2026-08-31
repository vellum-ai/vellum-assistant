import { recordTelemetryEvent } from "../telemetry/telemetry-events-outbox.js";
import type {
  LifecycleTelemetryEvent,
  TelemetryEventBase,
} from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

export interface LifecycleEvent {
  id: string;
  eventName: string;
  createdAt: number;
}

/**
 * Optional typed attributes a lifecycle event carries alongside its name.
 *
 * Every one is nullable and optional on the wire, so a caller with nothing to
 * say omits it and a platform that predates the field ignores it. They exist
 * so grouping dimensions (risk, access preset, surface) are columns rather
 * than substrings of `event_name`, which the server caps at 64 chars.
 */
export interface LifecycleEventAttributes {
  /**
   * Tool the event is about. The stable join key between a permission prompt
   * and its decision: `event_name` embeds a truncated tool name, this does not.
   */
  toolName?: string;
  /** Classified risk of the invocation ("low" | "medium" | "high"). */
  riskLevel?: string;
  /** Auto-approve threshold (access preset) in effect for the invocation. */
  riskThreshold?: string;
  /** Channel the event's turn runs on ("vellum", "slack", "telegram", ...). */
  surface?: string;
  /**
   * Parent conversation. Rides the same `share_analytics` gate as the
   * conversation ids on `turn` / `llm_usage` / `tool_executed`, and scopes the
   * pending outbox row so deleting the conversation deletes the row with it.
   */
  conversationId?: string;
}

/** Lifecycle wire payload minus the fields `recordTelemetryEvent` stamps. */
type LifecycleFields = Omit<LifecycleTelemetryEvent, keyof TelemetryEventBase>;

/**
 * Assemble the lifecycle wire fields, omitting attributes the caller left
 * unset so a plain `app_open` payload stays exactly as small as it was.
 *
 * An empty attribute is omitted rather than sent: the wire schema requires at
 * least one character, and a single failing field makes the server drop the
 * whole event silently.
 */
function buildLifecycleFields(
  eventName: string,
  attributes: LifecycleEventAttributes,
): LifecycleFields {
  const fields: LifecycleFields = { event_name: eventName };
  if (attributes.toolName) {
    fields.tool_name = attributes.toolName;
  }
  if (attributes.riskLevel) {
    fields.risk_level = attributes.riskLevel;
  }
  if (attributes.riskThreshold) {
    fields.risk_threshold = attributes.riskThreshold;
  }
  if (attributes.surface) {
    fields.surface = attributes.surface;
  }
  if (attributes.conversationId) {
    fields.conversation_id = attributes.conversationId;
  }
  return fields;
}

/**
 * Wire shape of one lifecycle event, for callers that insert outbox rows via
 * raw SQL (conversation-crud's clearAll audit path). Mirrors the shape
 * `recordTelemetryEvent` stamps — the shared `LifecycleTelemetryEvent` type
 * keeps them in sync.
 */
export function buildLifecycleTelemetryEvent(
  id: string,
  eventName: string,
  createdAt: number,
): LifecycleTelemetryEvent {
  return {
    type: "lifecycle",
    daemon_event_id: id,
    event_name: eventName,
    recorded_at: createdAt,
    assistant_version: APP_VERSION,
  };
}

/**
 * Record a lifecycle event (e.g. app_open, hatch) into the `telemetry_events`
 * outbox. Consent gating and degraded-mode `null` are `recordTelemetryEvent`'s.
 */
export function recordLifecycleEvent(
  eventName: string,
  attributes: LifecycleEventAttributes = {},
): LifecycleEvent | null {
  const recorded = recordTelemetryEvent(
    "lifecycle",
    buildLifecycleFields(eventName, attributes),
    { conversationId: attributes.conversationId ?? null },
  );
  return recorded ? { ...recorded, eventName } : null;
}
