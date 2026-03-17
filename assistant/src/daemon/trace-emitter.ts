import { v4 as uuid } from "uuid";

import type { TraceEvent } from "./message-types/messages.js";
import type { ServerMessage, TraceEventKind } from "./message-protocol.js";
import { persistTraceEvent } from "../memory/trace-event-store.js";
import { getLogger } from "../util/logger.js";

export type TraceEventStatus = "info" | "success" | "warning" | "error";

const log = getLogger("trace-emitter");

const SUMMARY_MAX_LENGTH = 200;
const ATTRIBUTE_VALUE_MAX_LENGTH = 500;

export interface TraceEmitOptions {
  requestId?: string;
  status?: TraceEventStatus;
  attributes?: Record<string, unknown>;
}

/**
 * Per-conversation utility that builds and sends TraceEvent messages to the client.
 * Maintains a monotonic sequence counter so the UI can reconstruct event order
 * even if timestamps collide.
 */
export class TraceEmitter {
  private sequence = 0;

  constructor(
    private readonly conversationId: string,
    private sendToClient: (msg: ServerMessage) => void,
  ) {}

  updateSender(sendToClient: (msg: ServerMessage) => void): void {
    this.sendToClient = sendToClient;
  }

  emit(kind: TraceEventKind, summary: string, opts?: TraceEmitOptions): void {
    const eventId = uuid();
    const truncatedSummary = truncate(summary, SUMMARY_MAX_LENGTH);
    const attributes = opts?.attributes
      ? normalizeAttributes(opts.attributes)
      : undefined;

    const event: ServerMessage = {
      type: "trace_event",
      eventId,
      conversationId: this.conversationId,
      requestId: opts?.requestId,
      timestampMs: Date.now(),
      sequence: this.sequence++,
      kind,
      status: opts?.status,
      summary: truncatedSummary,
      attributes,
    };

    try {
      persistTraceEvent(event as TraceEvent);
    } catch (err) {
      log.warn({ err, eventId }, "Failed to persist trace event");
    }

    this.sendToClient(event);
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function normalizeAttributes(
  attrs: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(attrs)) {
    result[key] = normalizeValue(value);
  }
  return result;
}

function normalizeValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string")
    return truncate(value, ATTRIBUTE_VALUE_MAX_LENGTH);
  // Coerce non-primitives to string
  try {
    const str = JSON.stringify(value);
    return truncate(str, ATTRIBUTE_VALUE_MAX_LENGTH);
  } catch {
    return "[non-serializable]";
  }
}
