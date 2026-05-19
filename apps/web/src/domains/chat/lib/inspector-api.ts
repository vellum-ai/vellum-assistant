
import { queryOptions, useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";

import type { LlmContextResponse } from "@/domains/chat/lib/inspector-types.js";

/**
 * Query helpers for the conversation LLM context inspector. Web port
 * of `LLMContextClient.swift` — wraps the daemon's
 * `GET /v1/messages/{messageId}/llm-context` endpoint, reached through
 * the platform's `RuntimeProxyWildcardView` at
 * `/v1/assistants/{assistantId}/messages/{messageId}/llm-context/`.
 *
 * The wildcard proxy isn't typed in `@tanstack/react-query.gen` so we
 * call `client.get` directly and provide our own response type from
 * `inspector-types.ts`.
 */

export class LlmContextRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LlmContextRequestError";
    this.status = status;
  }
}

export function llmContextQueryOptions(
  assistantId: string | undefined,
  messageId: string | undefined,
) {
  const enabled = Boolean(assistantId && messageId);
  return queryOptions({
    queryKey: [
      "assistants",
      assistantId,
      "messages",
      messageId,
      "llm-context",
    ] as const,
    queryFn: async ({ signal }): Promise<LlmContextResponse> => {
      if (!assistantId || !messageId) {
        throw new LlmContextRequestError(0, "Missing assistantId or messageId");
      }
      const { data, response } = await client.get<LlmContextResponse>({
        url: "/v1/assistants/{assistant_id}/messages/{message_id}/llm-context/",
        path: { assistant_id: assistantId, message_id: messageId },
        signal,
        throwOnError: false,
      });
      if (!response || !response.ok) {
        const text = await response
          ?.clone()
          .text()
          .catch(() => "");
        throw new LlmContextRequestError(
          response?.status ?? 0,
          text || response?.statusText || "Failed to load LLM context",
        );
      }
      if (!data) {
        throw new LlmContextRequestError(
          response.status,
          "Empty response from LLM context endpoint",
        );
      }
      return data;
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useLlmContext(
  assistantId: string | undefined,
  messageId: string | undefined,
) {
  return useQuery(llmContextQueryOptions(assistantId, messageId));
}
