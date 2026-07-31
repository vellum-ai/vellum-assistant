import { queryOptions, useQuery } from "@tanstack/react-query";

import { llmrequestlogsByIdContextGet } from "@/generated/daemon/sdk.gen";
import type { LlmrequestlogsByIdContextGetResponse } from "@/generated/daemon/types.gen";

/**
 * Lazy fetch hook for the normalized request/response sections of a
 * single LLM call. The list endpoints are queried with `view=summary`
 * (no per-log sections) to keep initial load fast; this hook fetches
 * the full normalized entry on demand for the selected call.
 *
 * Resolves to `null` on 404 — daemons that predate the per-log context
 * endpoint also ignore `view=summary`, so the list entry already
 * carries its sections and callers fall back to those.
 *
 * Route: GET /v1/llm-request-logs/:id/context (daemon)
 * Platform proxy: /v1/assistants/{assistant_id}/llm-request-logs/{log_id}/context/
 */

export type LlmCallDetail = LlmrequestlogsByIdContextGetResponse;

export class LlmCallDetailRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LlmCallDetailRequestError";
    this.status = status;
  }
}

export function llmCallDetailQueryOptions(
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
      "context",
    ] as const,
    queryFn: async ({ signal }): Promise<LlmCallDetail | null> => {
      if (!assistantId || !logId) {
        throw new LlmCallDetailRequestError(0, "Missing assistantId or logId");
      }
      const { data, response } = await llmrequestlogsByIdContextGet({
        path: { assistant_id: assistantId, id: logId },
        signal,
        throwOnError: false,
      });
      if (response?.status === 404) {
        return null;
      }
      if (!response || !response.ok || !data) {
        const text = await response
          ?.clone()
          .text()
          .catch(() => "");
        throw new LlmCallDetailRequestError(
          response?.status ?? 0,
          text || response?.statusText || "Failed to load call detail",
        );
      }
      return data;
    },
    enabled,
    staleTime: 5 * 60 * 1000, // normalized context is immutable per log
  });
}

export function useLlmCallDetail(
  assistantId: string | undefined,
  logId: string | undefined,
) {
  return useQuery(llmCallDetailQueryOptions(assistantId, logId));
}
