/**
 * Router retriever — the current production router (`runRouter`) adapted to the
 * harness `Retriever` interface.
 *
 * The union cap is left ON (no `disableUnionCap`) so the selection matches what
 * production would actually inject — the self-test grades the router against
 * its own injected ground truth.
 */

import { runRouter } from "../router.js";
import type {
  RetrievalInput,
  RetrievalOutput,
  Retriever,
} from "./retriever.js";

export function createRouterRetriever(): Retriever {
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
      });
      return {
        selectedSlugs: result.selectedSlugs,
        sourceBySlug: result.sourceBySlug,
        failureReason: result.failureReason,
      };
    },
  };
}
