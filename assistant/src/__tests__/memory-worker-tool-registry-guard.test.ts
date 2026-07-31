/**
 * Guard test: memory-worker tool registry bootstrap
 *
 * The standalone memory jobs worker (`src/plugins/defaults/memory/worker.ts`) hosts real agent
 * conversations — retrospective and consolidation passes, plus any subagents
 * they spawn — and those conversations resolve their tool surface from that
 * process's registry. The daemon and the schedule worker populate the
 * registry at startup via `initializeTools()`; the memory worker must do the
 * same or every tool a pass is granted (including `remember`, the point of a
 * retrospective) errors as "Unknown tool".
 *
 * Two layers:
 * 1. A source guard that the worker entrypoint calls `initializeTools()`.
 * 2. A behavioral check that `initializeTools()` actually yields the tools
 *    background passes depend on, so a manifest reshuffle that moves one of
 *    them behind daemon-only bootstrap (e.g. plugin `init()`) fails here
 *    instead of silently re-crippling worker-hosted conversations.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import {
  __resetRegistryForTesting,
  getTool,
  initializeTools,
} from "../tools/registry.js";

afterAll(() => {
  __resetRegistryForTesting();
});

describe("memory worker tool registry", () => {
  test("worker entrypoint populates the tool registry at startup", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "plugins", "defaults", "memory", "worker.ts"),
      "utf8",
    );
    expect(source).toContain("await initializeTools()");
  });

  test("initializeTools registers the tools background passes rely on", async () => {
    await initializeTools();

    // Granted by the retrospective wake allowlist (skill-authoring tools in
    // that allowlist are skill-projected per turn, not registry-backed, so
    // they are not asserted here).
    for (const name of ["remember", "recall", "skill_load"]) {
      expect(getTool(name), `expected registry tool "${name}"`).toBeDefined();
    }

    // Relied on by consolidation passes and fork-spawned subagents, whose
    // inherited transcripts assume the parent conversation's core surface.
    for (const name of ["bash", "file_read", "file_list", "skill_execute"]) {
      expect(getTool(name), `expected registry tool "${name}"`).toBeDefined();
    }
  });
});
