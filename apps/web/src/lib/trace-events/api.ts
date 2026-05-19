// Hand-written fetch wrappers intentionally — this endpoint is served by the
// assistant daemon via RuntimeProxyWildcardView under
// /v1/assistants/{id}/trace-events and is not part of the Django OpenAPI schema,
// so no generated HeyAPI hooks exist for it. Mirrors the pattern used by
// web/src/lib/memories/api.ts.
import { client } from "@/generated/api/client.gen.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api/errors.js";

import "@/lib/vellum-api/client.js";

import type { TraceEventsListResponse } from "@/lib/trace-events/types.js";

export { ApiError };

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

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
  const { data, error, response } = await client.get<
    TraceEventsListResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/trace-events",
    path: { assistant_id: assistantId },
    query: buildQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load trace events.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load trace events."),
    );
  }
  return data ?? { events: [] };
}
