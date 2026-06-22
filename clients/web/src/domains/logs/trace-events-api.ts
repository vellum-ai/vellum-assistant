/**
 * Fetch wrapper for the daemon's trace-events endpoint. Consumes the
 * generated daemon SDK; the response and row types are derived from the
 * route's declared schema.
 */

import { traceeventsGet } from "@/generated/daemon/sdk.gen";
import type { TraceeventsGetResponse } from "@/generated/daemon/types.gen";

export type TraceEventsListResponse = TraceeventsGetResponse;
export type TraceEventRow = TraceEventsListResponse["events"][number];
export type TraceEventKind = TraceEventRow["kind"];
export type TraceEventStatus = NonNullable<TraceEventRow["status"]>;

export class TraceEventsRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TraceEventsRequestError";
    this.status = status;
  }
}

export interface FetchTraceEventsParams {
  conversationId: string;
  limit?: number;
  afterSequence?: number;
}

export async function fetchTraceEvents(
  assistantId: string,
  params: FetchTraceEventsParams,
): Promise<TraceEventsListResponse> {
  const { data, response } = await traceeventsGet({
    path: { assistant_id: assistantId },
    query: {
      conversationId: params.conversationId,
      limit: params.limit,
      afterSequence: params.afterSequence,
    },
    throwOnError: false,
  });
  if (!response?.ok) {
    const text = await response
      ?.clone()
      .text()
      .catch(() => "");
    throw new TraceEventsRequestError(
      response?.status ?? 0,
      text || response?.statusText || "Failed to load trace events",
    );
  }
  return data ?? { events: [] };
}
