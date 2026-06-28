/**
 * `init` hook for the memory-reference plugin.
 *
 * Bootstraps the plugin's durable state entirely through the public host
 * facets handed in on {@link InitContext.host}:
 *   - declares its fact table via `host.store.migrate` (append-only, idempotent)
 *   - resolves its dense-vector collection via `host.vectorStore`, sized to the
 *     host's embedding backend
 *   - registers the post-turn consolidation job handler via `host.jobs`
 *
 * Imports ONLY `@vellumai/plugin-api`. No `assistant/` source, no `getDb`, no
 * `persistence/`.
 */

import type { InitContext, PluginJob } from "@vellumai/plugin-api";

import {
  CONSOLIDATE_JOB,
  DEFAULT_VECTOR_SIZE,
  embedOne,
  ensureCollection,
  extractText,
  FACTS_TABLE,
  rememberFact,
  setRuntime,
} from "../src/state.js";

/** Payload the turn-commit hook enqueues for the consolidation job. */
interface ConsolidatePayload {
  conversationId: string;
  userMessageId: string;
  turnCount: number;
}

export default async function init(ctx: InitContext): Promise<void> {
  if (ctx.host === undefined) {
    // Lightweight test contexts may construct an InitContext without a host;
    // a plugin that needs the host simply no-ops when it is absent rather than
    // throwing during a host-less bootstrap.
    ctx.logger.warn(
      {},
      "memory-reference: no host on init context — skipping setup",
    );
    return;
  }

  const rt = setRuntime(ctx.host);

  // 1) Declare the durable fact table. Append-only & idempotent — safe on every
  // boot. The host namespaces the table under `plugin_<id>_` and rejects DDL
  // that touches anything outside that prefix.
  rt.store.migrate([
    {
      name: "0001-create-facts",
      up: (exec) => {
        exec(
          `CREATE TABLE IF NOT EXISTS ${FACTS_TABLE} (
             id TEXT PRIMARY KEY,
             conversation_id TEXT NOT NULL,
             text TEXT NOT NULL,
             created_at INTEGER NOT NULL
           )`,
        );
      },
    },
    {
      name: "0002-index-facts-conversation",
      up: (exec) => {
        exec(
          `CREATE INDEX IF NOT EXISTS ${FACTS_TABLE}_conversation_idx
             ON ${FACTS_TABLE} (conversation_id)`,
        );
      },
    },
  ]);

  // 2) Size and resolve the vector collection. Probe the embedding backend once
  // to learn its dimensionality; if no backend is configured the probe throws —
  // defer collection creation to the first successful embed (in remember).
  let vectorSize = DEFAULT_VECTOR_SIZE;
  try {
    const probe = await embedOne(rt, "memory-reference dimension probe");
    vectorSize = probe.length;
    await ensureCollection(rt, vectorSize);
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-reference: embedding probe failed — deferring vector collection creation",
    );
  }

  // 3) Register the consolidation job handler. The handler runs on the worker
  // loop (never synchronously, never at boot), so the salient-fact extraction it
  // does is off the turn-commit hot path. This reference keeps the handler
  // LLM-free: it stores the user's prompt text as a fact rather than calling a
  // model. A production plugin would summarize the turn here — still on the
  // worker, still off the commit path.
  rt.jobs.registerHandler(CONSOLIDATE_JOB, async (job: PluginJob) => {
    const payload = job.payload as unknown as ConsolidatePayload;
    const recent = await rt.history.getRecentMessages(
      payload.conversationId,
      2,
    );
    const userTurn = recent.find((m) => m.role === "user");
    if (userTurn === undefined) return;

    const text = extractText(userTurn.content).slice(0, 2000).trim();
    if (text.length === 0) return;

    await rememberFact(rt, payload.conversationId, text);
  });

  ctx.logger.info({ vectorSize }, "memory-reference: initialized");
}
