import { queryOptions, useQuery } from "@tanstack/react-query";

import { llmrequestlogsByIdPayloadGet } from "@/generated/daemon/sdk.gen";
import type { LlmrequestlogsByIdPayloadGetResponse } from "@/generated/daemon/types.gen";

/**
 * Lazy fetch hook for the raw request/response payloads of a single LLM
 * call. Payloads are omitted from the list endpoint to keep initial load
 * fast; this hook fetches them on demand when the Raw tab is opened.
 *
 * Route: GET /v1/llm-request-logs/:id/payload (daemon)
 * Platform proxy: /v1/assistants/{assistant_id}/llm-request-logs/{log_id}/payload/
 */

export type LlmLogPayload = LlmrequestlogsByIdPayloadGetResponse;

export class LlmPayloadRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LlmPayloadRequestError";
    this.status = status;
  }
}

export function llmLogPayloadQueryOptions(
  assistantId: string | undefined,
  logId: string | undefined,
) {
  const enabled = Boolean(assistantId && logId);
  return queryOptions({
    queryKey: [
      "assistants",
      assistantId,
      "llm-request-logs",
      logId,
      "payload",
    ] as const,
    queryFn: async ({ signal }): Promise<LlmLogPayload> => {
      if (!assistantId || !logId) {
        throw new LlmPayloadRequestError(0, "Missing assistantId or logId");
      }
      const { data, response } = await llmrequestlogsByIdPayloadGet({
        path: { assistant_id: assistantId, id: logId },
        signal,
        throwOnError: false,
      });
      if (!response || !response.ok) {
        const text = await response
          ?.clone()
          .text()
          .catch(() => "");
        throw new LlmPayloadRequestError(
          response?.status ?? 0,
          text || response?.statusText || "Failed to load payload",
        );
      }
      return data ?? { id: logId, requestPayload: null, responsePayload: null };
    },
    enabled,
    staleTime: 5 * 60 * 1000, // payloads are immutable
  });
}

export function useLlmLogPayload(
  assistantId: string | undefined,
  logId: string | undefined,
) {
  return useQuery(llmLogPayloadQueryOptions(assistantId, logId));
}
