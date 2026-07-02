import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { DOMAIN_JOB_HANDLERS } from "../persistence/job-handlers/manifest.js";
import {
  getMemoryPersistenceHooks,
  resetMemoryPersistenceHooksForTests,
} from "../persistence/memory-lifecycle-hooks.js";
import {
  registerDefaultPluginJobHandlers,
  registerDefaultPluginPersistenceHooks,
} from "../plugins/defaults/index.js";
import {
  clearJobHandlerRegistry,
  getRegisteredJobHandlerFor,
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
].sort();

/**
 * Job types the daemon owns directly (not a plugin): persistence cleanup,
 * message-content lexical indexing, conversations, media, home, runtime. These
 * live in the static `DOMAIN_JOB_HANDLERS` manifest the worker seeds from.
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

  it("the domain manifest wires exactly the non-plugin job types", () => {
    expect(Object.keys(DOMAIN_JOB_HANDLERS).sort()).toEqual(
      NON_PLUGIN_JOB_TYPES,
    );
    // No plugin/domain overlap — every type is owned by exactly one side.
    const memory = new Set(MEMORY_JOB_TYPES);
    expect(NON_PLUGIN_JOB_TYPES.filter((t) => memory.has(t))).toEqual([]);
  });

  it("every memory job type resolves through the registry (no forwarding step)", () => {
    registerDefaultPluginJobHandlers();
    for (const type of MEMORY_JOB_TYPES) {
      expect(getRegisteredJobHandlerFor(type)).toBeDefined();
    }
    // Domain types are not plugin-contributed — they come from the manifest.
    expect(
      getRegisteredJobHandlerFor("prune_old_conversations"),
    ).toBeUndefined();
  });

  it("registerDefaultPluginPersistenceHooks wires the persistence-lifecycle seam (the standalone worker has no bootstrap)", () => {
    resetMemoryPersistenceHooksForTests();
    const before = getMemoryPersistenceHooks();
    registerDefaultPluginPersistenceHooks();
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
