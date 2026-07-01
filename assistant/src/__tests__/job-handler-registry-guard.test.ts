import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { registerMemoryJobHandlers } from "../jobs/register-job-handlers.js";
import * as jobsWorker from "../persistence/jobs-worker.js";
import {
  getMemoryPersistenceHooks,
  resetMemoryPersistenceHooksForTests,
} from "../persistence/memory-lifecycle-hooks.js";
import { registerDefaultPluginJobHandlers } from "../plugins/defaults/index.js";
import {
  clearJobHandlerRegistry,
  getRegisteredJobHandlers,
  registerPluginJobHandlers,
} from "../plugins/job-handler-registry.js";

/**
 * The exact job types the `default-memory` plugin contributes via its
 * `jobHandlers` field. Locks the contribution against an accidental add/drop —
 * the job-handler analog of the injector order guard.
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
  "index_message_lexical",
  "purge_conversation_lexical",
  "backfill_lexical_index",
].sort();

/**
 * Job types wired directly by `registerMemoryJobHandlers` for domains that are
 * not plugins (persistence cleanup, conversations, media, home, runtime).
 */
const NON_PLUGIN_JOB_TYPES = [
  "prune_old_conversations",
  "prune_old_llm_request_logs",
  "prune_old_trace_events",
  "prune_old_tool_invocations",
  "build_conversation_summary",
  "media_processing",
  "conversation_analyze",
  "generate_conversation_starters",
].sort();

describe("job-handler registry — memory plugin contribution", () => {
  beforeEach(() => {
    clearJobHandlerRegistry();
  });
  afterEach(() => {
    clearJobHandlerRegistry();
    resetMemoryPersistenceHooksForTests();
  });

  it("default-memory contributes exactly the memory job types", () => {
    registerDefaultPluginJobHandlers();
    const types = getRegisteredJobHandlers()
      .map((e) => e.type)
      .sort();
    expect(types).toEqual(MEMORY_JOB_TYPES);
    // Globally unique types (the registry would have thrown on a dupe).
    expect(new Set(types).size).toBe(types.length);
  });

  it("registerMemoryJobHandlers wires the full job-type set into the worker", () => {
    const captured: string[] = [];
    const spy = spyOn(jobsWorker, "registerJobHandler").mockImplementation(
      (type: string) => {
        captured.push(type);
      },
    );
    try {
      registerMemoryJobHandlers();
    } finally {
      spy.mockRestore();
    }
    const expected = [...MEMORY_JOB_TYPES, ...NON_PLUGIN_JOB_TYPES].sort();
    expect(captured.slice().sort()).toEqual(expected);
    // Each type registered exactly once — no plugin/non-plugin overlap, no drop.
    expect(new Set(captured).size).toBe(captured.length);
  });

  it("registerMemoryJobHandlers also wires the persistence-lifecycle seam (the standalone worker has no bootstrap)", () => {
    resetMemoryPersistenceHooksForTests();
    const before = getMemoryPersistenceHooks();
    const spy = spyOn(jobsWorker, "registerJobHandler").mockImplementation(
      () => {},
    );
    try {
      registerMemoryJobHandlers();
    } finally {
      spy.mockRestore();
    }
    // The seam must move off the no-op default — otherwise the standalone
    // worker's fork-based retrospectives silently drop carried memory state.
    expect(getMemoryPersistenceHooks()).not.toBe(before);
  });

  it("rejects a duplicate job-handler type across plugins", () => {
    registerPluginJobHandlers("plugin-a", [
      { type: "graph_extract", handler: () => undefined },
    ]);
    expect(() =>
      registerPluginJobHandlers("plugin-b", [
        { type: "graph_extract", handler: () => undefined },
      ]),
    ).toThrow(/already registered by plugin "plugin-a"/);
  });
});
