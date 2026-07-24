import { createHash } from "node:crypto";

import { APP_VERSION } from "../version.js";
import { recordTelemetryOutboxEvent } from "./telemetry-events-outbox.js";
import type { AssistantResultSeenTelemetryEvent } from "./types.js";

/**
 * Input for one `assistant_result_seen` telemetry event. Metadata only — the
 * signal's evidence text and arbitrary attention metadata are deliberately
 * omitted; only the seen-cursor coordinates and provenance dimensions ship.
 */
export interface AssistantResultSeenRecord {
  conversationId: string;
  /** Id of the attention evidence row this seen signal appended. */
  attentionEventId: string;
  /** Assistant message the signal newly marked as seen. */
  assistantMessageId: string;
  /** Epoch-ms `created_at` of the covered assistant message. */
  assistantMessageRecordedAt: number;
  signalType: string;
  confidence: string;
  sourceChannel: string | null;
  sourceInterface: string | null;
}

/**
 * Deterministic `daemon_event_id` for an `assistant_result_seen` event, keyed
 * on the attention event id and the covered assistant message id. A retried
 * emission of the same seen signal produces the same id, so the ingest-side
 * dedup (keyed on `daemon_event_id`, earliest-wins) collapses it to one row.
 * SHA-256 hex keeps the id within the wire's 128-char bound regardless of the
 * component id lengths.
 */
export function buildAssistantResultSeenDaemonEventId(
  attentionEventId: string,
  assistantMessageId: string,
): string {
  const digest = createHash("sha256")
    .update(`${attentionEventId}:${assistantMessageId}`)
    .digest("hex");
  return `assistant_result_seen:${digest}`;
}

/**
 * Record an `assistant_result_seen` telemetry event on the `telemetry_events`
 * outbox, with the conversation id in its dedicated column so conversation
 * deletion redacts pending rows via an indexed delete. Consent gating and
 * degraded-mode `null` are {@link recordTelemetryOutboxEvent}'s.
 */
export function recordAssistantResultSeen(
  record: AssistantResultSeenRecord,
): void {
  recordTelemetryOutboxEvent(
    "assistant_result_seen",
    (_id, createdAt): AssistantResultSeenTelemetryEvent => ({
      type: "assistant_result_seen",
      daemon_event_id: buildAssistantResultSeenDaemonEventId(
        record.attentionEventId,
        record.assistantMessageId,
      ),
      recorded_at: createdAt,
      assistant_version: APP_VERSION,
      conversation_id: record.conversationId,
      assistant_message_id: record.assistantMessageId,
      assistant_message_recorded_at: record.assistantMessageRecordedAt,
      signal_type: record.signalType,
      confidence: record.confidence,
      source_channel: record.sourceChannel,
      source_interface: record.sourceInterface,
    }),
    { conversationId: record.conversationId },
  );
}
