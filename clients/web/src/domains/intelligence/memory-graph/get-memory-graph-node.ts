/**
 * TanStack Query options for `GET /memory-graph-node` — the on-demand content
 * of a single concept node, fetched when a user opens a node in the graph.
 */

import { queryOptions } from "@tanstack/react-query";

import { memorygraphnodeGet } from "@/generated/daemon/sdk.gen";
import { t } from "@/i18n";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import type { MemoryGraphNodeDetail } from "./types";

function failureMessage(): string {
  return t("getMemoryGraphNode.failureMessage", { ns: "intelligence" });
}

export function memoryGraphNodeOptions(assistantId: string, id: string | null) {
  return queryOptions<MemoryGraphNodeDetail>({
    queryKey: ["memory-graph-node", assistantId, id] as const,
    enabled: Boolean(assistantId && id),
    queryFn: async (): Promise<MemoryGraphNodeDetail> => {
      const { data, error, response } = await memorygraphnodeGet({
        path: { assistant_id: assistantId },
        query: { id: id ?? "" },
        throwOnError: false,
      });

      assertHasResponse(response, error, failureMessage());

      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, failureMessage()),
        );
      }

      return (data as MemoryGraphNodeDetail | undefined) ?? { found: false };
    },
  });
}
