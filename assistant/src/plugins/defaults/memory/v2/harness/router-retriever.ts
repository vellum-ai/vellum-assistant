/**
 * Router retriever — the current production router (`runRouter`) adapted to the
 * harness `Retriever` interface.
 *
 * The union cap is left ON (no `disableUnionCap`) so the selection matches what
 * production would actually inject — the self-test grades the router against
 * its own injected ground truth.
 */

import type { DrizzleDb } from "../../../../../persistence/db-connection.js";
import { runRouter } from "../router.js";
import type {
  RetrievalInput,
  RetrievalOutput,
  Retriever,
} from "./retriever.js";

/**
 * @param database optional handle for tier-2 EMA scoring, forwarded to
 * `runRouter`. Omit to exercise only the tier-1 / tier-3 paths (as the router's
 * own tests do).
 */
export function createRouterRetriever(database?: DrizzleDb): Retriever {
  return {
    name: "router",
    async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
      const result = await runRouter({
        workspaceDir: input.workspaceDir,
        recentTurnPairs: input.recentTurnPairs,
        nowText: input.nowText,
        priorEverInjected: input.priorEverInjected,
        config: input.config,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(database ? { database } : {}),
      });
      return {
        selectedSlugs: result.selectedSlugs,
        sourceBySlug: result.sourceBySlug,
        failureReason: result.failureReason,
      };
    },
  };
}
