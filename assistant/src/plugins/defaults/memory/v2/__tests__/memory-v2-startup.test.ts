import { describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../../../config/schema.js";

function fakeConfig(): AssistantConfig {
  return {
    memory: { v2: { enabled: true } },
  } as unknown as AssistantConfig;
}

/**
 * Reset and re-install the mocks for the collaborator modules
 * `maybeRebuildMemoryV2Concepts` pulls in, then re-import the module under test
 * so its dynamic imports resolve to the freshly-mocked collaborators. Returns
 * the spies plus the re-imported function.
 *
 * Drives the empty-after-create branch (collection not migrated, zero points,
 * pages on disk) so the reembed enqueue decision is reached, and lets the test
 * choose whether a `memory_v2_reembed` job is already in-flight.
 */
async function withMocks(opts: { reembedInFlight: boolean }) {
  const spies = {
    enqueueMemoryJob: mock(() => "job-id"),
    hasActiveJobOfType: mock(
      (type: string) => opts.reembedInFlight && type === "memory_v2_reembed",
    ),
    ensureConceptPageCollection: mock(async () => ({ migrated: false })),
    countConceptPagePoints: mock(async () => 0),
    clearReembedSentinel: mock(async () => {}),
    hasConceptPages: mock(async () => true),
  };

  mock.module("../../../../../persistence/jobs-store.js", () => ({
    enqueueMemoryJob: spies.enqueueMemoryJob,
    hasActiveJobOfType: spies.hasActiveJobOfType,
  }));
  mock.module("../qdrant.js", () => ({
    ensureConceptPageCollection: spies.ensureConceptPageCollection,
    countConceptPagePoints: spies.countConceptPagePoints,
    clearReembedSentinel: spies.clearReembedSentinel,
  }));
  mock.module("../page-store.js", () => ({
    hasConceptPages: spies.hasConceptPages,
  }));
  const realPlatform = await import("../../../../../util/platform.js");
  mock.module("../../../../../util/platform.js", () => ({
    ...realPlatform,
    getWorkspaceDir: () => "/tmp/workspace",
  }));

  const mod = await import("../memory-v2-startup.js");
  return {
    spies,
    maybeRebuildMemoryV2Concepts: mod.maybeRebuildMemoryV2Concepts,
  };
}

describe("maybeRebuildMemoryV2Concepts reembed dedup", () => {
  test("does NOT enqueue a second reembed when one is already in-flight", async () => {
    const { spies, maybeRebuildMemoryV2Concepts } = await withMocks({
      reembedInFlight: true,
    });

    await maybeRebuildMemoryV2Concepts(fakeConfig());

    expect(spies.hasActiveJobOfType).toHaveBeenCalledWith("memory_v2_reembed");
    expect(spies.enqueueMemoryJob).toHaveBeenCalledTimes(0);
    // The sentinel is still retired even when the enqueue is skipped.
    expect(spies.clearReembedSentinel).toHaveBeenCalledTimes(1);
  });

  test("enqueues the reembed when none is in-flight", async () => {
    const { spies, maybeRebuildMemoryV2Concepts } = await withMocks({
      reembedInFlight: false,
    });

    await maybeRebuildMemoryV2Concepts(fakeConfig());

    expect(spies.enqueueMemoryJob).toHaveBeenCalledTimes(1);
    expect(spies.enqueueMemoryJob).toHaveBeenCalledWith(
      "memory_v2_reembed",
      {},
    );
    expect(spies.clearReembedSentinel).toHaveBeenCalledTimes(1);
  });
});
