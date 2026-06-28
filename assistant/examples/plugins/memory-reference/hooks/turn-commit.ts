/**
 * `turn-commit` hook for the memory-reference plugin.
 *
 * Fires after the turn's messages are persisted. It does NO synchronous work
 * beyond enqueuing a durable background job via `host.jobs` — the consolidation
 * (salient-fact extraction + embed + store) runs later on the worker loop, off
 * the commit hot path, so a turn is never charged generation cost just by
 * committing. The handler is registered in the `init` hook.
 *
 * Imports ONLY `@vellumai/plugin-api`.
 */

import type { TurnCommitContext } from "@vellumai/plugin-api";

import { CONSOLIDATE_JOB, tryGetRuntime } from "../src/state.js";

export default async function turnCommit(
  ctx: TurnCommitContext,
): Promise<void> {
  const rt = tryGetRuntime();
  if (rt === null) return;

  rt.jobs.enqueue(CONSOLIDATE_JOB, {
    conversationId: ctx.conversationId,
    userMessageId: ctx.userMessageId,
    turnCount: ctx.turnCount,
  });

  ctx.logger.info(
    { plugin: "memory-reference", turnCount: ctx.turnCount },
    "memory-reference: enqueued consolidation job",
  );
}
