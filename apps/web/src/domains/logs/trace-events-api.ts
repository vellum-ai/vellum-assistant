/**
 * Hand-written fetch wrapper for the daemon's trace-events endpoint.
 * The endpoint is served via RuntimeProxyWildcardView under
 * /v1/assistants/{id}/trace-events and is not part of the Django
 * OpenAPI schema, so no generated HeyAPI hooks exist for it.
 */

import { client } from "@/generated/api/client.gen";

import type { TraceEventsListResponse } from "./trace-events-types";

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

function buildQuery(params: FetchTraceEventsParams): Record<string, string> {
  const query: Record<string, string> = {
    conversationId: params.conversationId,
  };
  if (params.limit !== undefined) {
    query.limit = String(params.limit);
  }
  if (params.afterSequence !== undefined) {
    query.afterSequence = String(params.afterSequence);
  }
  return query;
}

export async function fetchTraceEvents(
  assistantId: string,
  params: FetchTraceEventsParams,
): Promise<TraceEventsListResponse> {
  const { data, response } = await client.get<TraceEventsListResponse>({
    url: "/v1/assistants/{assistant_id}/trace-events",
    path: { assistant_id: assistantId },
    query: buildQuery(params),
    throwOnError: false,
  });
  if (!response || !response.ok) {
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
