import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { registerMemoryPluginJobHandlers } from "../plugins/defaults/memory/job-handler-registration.js";
import * as jobsWorker from "../plugins/defaults/memory/jobs-worker.js";
import {
  getMemoryPersistenceHooks,
  registerMemoryPersistenceHooks,
  resetMemoryPersistenceHooksForTests,
} from "../plugins/defaults/memory/persistence-lifecycle-seam.js";

/**
 * The exact memory-plugin job types. Locks the contribution against an
 * accidental add/drop — the job-handler analog of the injector order guard.
 */
const MEMORY_JOB_TYPES = [
  "embed_segment",
  "embed_summary",
  "backfill",
  "rebuild_index",
  "delete_qdrant_vectors",
  "embed_media",
  "embed_attachment",
  "embed_graph_node",
  "embed_pkb_file",
  "graph_trigger_embed",
  "graph_extract",
  "graph_decay",
  "graph_consolidate",
  "graph_pattern_scan",
  "graph_narrative_refine",
  "graph_bootstrap",
  "embed_concept_page",
  "memory_v2_sweep",
  "memory_v2_consolidate",
  "memory_v2_migrate",
  "memory_v2_reembed",
  "memory_v2_activation_recompute",
  "memory_v3_maintain",
  "memory_retrospective",
  "pkb_filing",
  "pkb_compaction",
].sort();

/**
 * Job types the host owns (not a plugin): persistence cleanup, message-content
 * lexical indexing, conversations, media, home, runtime. Registered alongside
 * the memory handlers today; they will move to a memory-agnostic background
 * schedule worker in a future rework.
 */
const NON_PLUGIN_JOB_TYPES = [
  "prune_old_conversations",
  "prune_old_llm_request_logs",
  "prune_old_trace_events",
  "prune_old_tool_invocations",
  "index_message_lexical",
  "purge_conversation_lexical",
  "delete_message_lexical",
  "backfill_lexical_index",
  "build_conversation_summary",
  "media_processing",
  "conversation_analyze",
  "generate_conversation_starters",
].sort();

function captureRegisteredTypes(register: () => void): string[] {
  const captured: string[] = [];
  const spy = spyOn(jobsWorker, "registerJobHandler").mockImplementation(
    (type: string) => {
      captured.push(type);
    },
  );
  try {
    register();
  } finally {
    spy.mockRestore();
  }
  return captured;
}

describe("job-handler registration", () => {
  afterEach(() => {
    resetMemoryPersistenceHooksForTests();
  });

  it("registers exactly the memory job types plus the non-plugin domain types", () => {
    const captured = captureRegisteredTypes(registerMemoryPluginJobHandlers);
    const expected = [...MEMORY_JOB_TYPES, ...NON_PLUGIN_JOB_TYPES].sort();
    expect(captured.slice().sort()).toEqual(expected);
    // Each type registered exactly once — no plugin/domain overlap, no drop.
    expect(new Set(captured).size).toBe(captured.length);
  });

  it("the memory and domain type sets do not overlap", () => {
    const memory = new Set(MEMORY_JOB_TYPES);
    expect(NON_PLUGIN_JOB_TYPES.filter((t) => memory.has(t))).toEqual([]);
  });

  it("registerMemoryPersistenceHooks wires the persistence-lifecycle seam (the standalone worker has no bootstrap)", () => {
    resetMemoryPersistenceHooksForTests();
    const before = getMemoryPersistenceHooks();
    registerMemoryPersistenceHooks();
    // The seam must move off the no-op default — otherwise the standalone
    // worker's fork-based retrospectives silently drop carried memory state.
    expect(getMemoryPersistenceHooks()).not.toBe(before);
  });
});
