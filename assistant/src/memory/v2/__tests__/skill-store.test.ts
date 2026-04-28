/**
 * Tests for `assistant/src/memory/v2/skill-store.ts`.
 *
 * Coverage matrix from PR 5 acceptance criteria:
 *   - `seedV2SkillEntries` enumerates the catalog and calls
 *     `upsertSkillEmbedding` for each enabled skill.
 *   - It skips skills whose declared feature flag is disabled.
 *   - It calls `pruneSkillsExcept` with the active id list.
 *   - It populates the `entries` cache so `getSkillCapability` returns each entry.
 *   - It swallows errors from the embedding backend — the function resolves
 *     and the cache is unchanged from prior state.
 *
 * Hermetic by design: the catalog loader, state resolver, embedding backend,
 * Qdrant module, and feature-flag resolver are all module-mocked so the suite
 * never reaches a real backend or filesystem.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { ResolvedSkill } from "../../../config/skill-state.js";
import type { SkillSummary } from "../../../config/skills.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// ---------------------------------------------------------------------------
// Programmable test state — drives every mocked dependency below.
// ---------------------------------------------------------------------------

interface TestState {
  catalog: SkillSummary[];
  resolved: ResolvedSkill[];
  flagsEnabled: Record<string, boolean>;
  embedThrows: Error | null;
  embedReturn: number[][];
  sparseReturn: { indices: number[]; values: number[] };
  upsertCalls: Array<{
    id: string;
    content: string;
    dense: number[];
    sparse: { indices: number[]; values: number[] };
    updatedAt: number;
  }>;
  pruneCalls: Array<readonly string[]>;
  upsertThrows: Error | null;
}

const state: TestState = {
  catalog: [],
  resolved: [],
  flagsEnabled: {},
  embedThrows: null,
  embedReturn: [],
  sparseReturn: { indices: [1], values: [1] },
  upsertCalls: [],
  pruneCalls: [],
  upsertThrows: null,
};

// Stub config so resolveSkillStates / mcp augmentation have something to read.
mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      qdrant: { url: "http://127.0.0.1:6333", vectorSize: 3, onDisk: false },
    },
    mcp: { servers: {} },
    skills: { entries: {}, allowBundled: null },
  }),
}));

mock.module("../../../config/skills.js", () => ({
  loadSkillCatalog: () => state.catalog,
}));

mock.module("../../../config/skill-state.js", () => ({
  resolveSkillStates: () => state.resolved,
}));

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    state.flagsEnabled[key] ?? true,
}));

mock.module("../../embedding-backend.js", () => ({
  embedWithBackend: async (_config: unknown, inputs: unknown[]) => {
    if (state.embedThrows) throw state.embedThrows;
    // Echo the configured per-call vectors back, padded if needed.
    const vectors = state.embedReturn.length
      ? state.embedReturn
      : inputs.map(() => [0.1, 0.2, 0.3]);
    return { provider: "local", model: "test-model", vectors };
  },
  generateSparseEmbedding: () => state.sparseReturn,
}));

mock.module("../skill-qdrant.js", () => ({
  upsertSkillEmbedding: async (params: TestState["upsertCalls"][number]) => {
    if (state.upsertThrows) throw state.upsertThrows;
    state.upsertCalls.push(params);
  },
  pruneSkillsExcept: async (ids: readonly string[]) => {
    state.pruneCalls.push(ids);
  },
}));

// Imported AFTER all mocks are wired so the module under test sees the stubs.
const { seedV2SkillEntries, getSkillCapability, _resetSkillStoreForTests } =
  await import("../skill-store.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "example-skill-a",
    name: "example-skill-a",
    displayName: "Example Skill A",
    description: "Does an example thing A",
    directoryPath: "/tmp/skills/example-skill-a",
    skillFilePath: "/tmp/skills/example-skill-a/SKILL.md",
    source: "managed",
    ...overrides,
  };
}

function resetState(): void {
  state.catalog = [];
  state.resolved = [];
  state.flagsEnabled = {};
  state.embedThrows = null;
  state.embedReturn = [];
  state.sparseReturn = { indices: [1], values: [1] };
  state.upsertCalls.length = 0;
  state.pruneCalls.length = 0;
  state.upsertThrows = null;
  _resetSkillStoreForTests();
}

beforeEach(resetState);
afterEach(resetState);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("seedV2SkillEntries", () => {
  test("enumerates the catalog and upserts one point per enabled skill", async () => {
    const skillA = makeSummary({
      id: "example-skill-a",
      displayName: "Skill A",
    });
    const skillB = makeSummary({
      id: "example-skill-b",
      displayName: "Skill B",
    });
    state.catalog = [skillA, skillB];
    state.resolved = [
      { summary: skillA, state: "enabled" },
      { summary: skillB, state: "enabled" },
    ];
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(2);
    const ids = state.upsertCalls.map((c) => c.id).sort();
    expect(ids).toEqual(["example-skill-a", "example-skill-b"]);

    // Each upsert carries the per-skill dense + sparse + content payload.
    const callA = state.upsertCalls.find((c) => c.id === "example-skill-a")!;
    expect(callA.dense).toEqual([0.1, 0.2, 0.3]);
    expect(callA.sparse).toEqual(state.sparseReturn);
    expect(callA.content).toContain("Skill A");
    expect(callA.content).toContain("(example-skill-a)");
    expect(callA.updatedAt).toBeGreaterThan(0);
  });

  test("skips disabled skills (state !== 'enabled')", async () => {
    const enabled = makeSummary({ id: "example-skill-a" });
    const disabled = makeSummary({ id: "example-skill-b" });
    state.catalog = [enabled, disabled];
    state.resolved = [
      { summary: enabled, state: "enabled" },
      { summary: disabled, state: "disabled" },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].id).toBe("example-skill-a");
  });

  test("skips skills whose declared feature flag is disabled", async () => {
    const flagged = makeSummary({
      id: "example-skill-a",
      featureFlag: "experimental-flag",
    });
    const unflagged = makeSummary({ id: "example-skill-b" });
    state.catalog = [flagged, unflagged];
    state.resolved = [
      { summary: flagged, state: "enabled" },
      { summary: unflagged, state: "enabled" },
    ];
    state.flagsEnabled = { "experimental-flag": false };
    state.embedReturn = [[0.4, 0.5, 0.6]];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].id).toBe("example-skill-b");
  });

  test("calls pruneSkillsExcept with the active id list", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    const skillB = makeSummary({ id: "example-skill-b" });
    state.catalog = [skillA, skillB];
    state.resolved = [
      { summary: skillA, state: "enabled" },
      { summary: skillB, state: "enabled" },
    ];
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2SkillEntries();

    expect(state.pruneCalls).toHaveLength(1);
    expect([...state.pruneCalls[0]].sort()).toEqual([
      "example-skill-a",
      "example-skill-b",
    ]);
  });

  test("passes only the active (post-flag-filter) ids to pruneSkillsExcept", async () => {
    const flagged = makeSummary({
      id: "example-skill-a",
      featureFlag: "off-flag",
    });
    const unflagged = makeSummary({ id: "example-skill-b" });
    state.catalog = [flagged, unflagged];
    state.resolved = [
      { summary: flagged, state: "enabled" },
      { summary: unflagged, state: "enabled" },
    ];
    state.flagsEnabled = { "off-flag": false };
    state.embedReturn = [[0.4, 0.5, 0.6]];

    await seedV2SkillEntries();

    expect(state.pruneCalls).toHaveLength(1);
    expect([...state.pruneCalls[0]]).toEqual(["example-skill-b"]);
  });

  test("populates the entries cache so getSkillCapability returns each entry", async () => {
    const skillA = makeSummary({
      id: "example-skill-a",
      displayName: "Skill A",
    });
    const skillB = makeSummary({
      id: "example-skill-b",
      displayName: "Skill B",
    });
    state.catalog = [skillA, skillB];
    state.resolved = [
      { summary: skillA, state: "enabled" },
      { summary: skillB, state: "enabled" },
    ];
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    expect(getSkillCapability("example-skill-a")).toBeNull();

    await seedV2SkillEntries();

    const entryA = getSkillCapability("example-skill-a");
    const entryB = getSkillCapability("example-skill-b");
    expect(entryA).not.toBeNull();
    expect(entryA?.id).toBe("example-skill-a");
    expect(entryA?.content).toContain("Skill A");

    expect(entryB).not.toBeNull();
    expect(entryB?.id).toBe("example-skill-b");
    expect(entryB?.content).toContain("Skill B");

    // Unknown ids return null even when the cache is populated.
    expect(getSkillCapability("unknown-skill")).toBeNull();
  });

  test("swallows errors from embedWithBackend and leaves prior cache intact", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    // First run populates the cache.
    await seedV2SkillEntries();
    const before = getSkillCapability("example-skill-a");
    expect(before).not.toBeNull();

    // Second run: embedding throws — the function must resolve, the cache
    // must be unchanged, and no new upsert/prune should have happened.
    state.upsertCalls.length = 0;
    state.pruneCalls.length = 0;
    state.embedThrows = new Error("backend exploded");

    await expect(seedV2SkillEntries()).resolves.toBeUndefined();

    expect(state.upsertCalls).toHaveLength(0);
    expect(state.pruneCalls).toHaveLength(0);
    const after = getSkillCapability("example-skill-a");
    expect(after).toEqual(before);
  });

  test("no enabled skills yields empty cache and a single empty prune call", async () => {
    state.catalog = [];
    state.resolved = [];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(0);
    expect(state.pruneCalls).toHaveLength(1);
    expect([...state.pruneCalls[0]]).toEqual([]);
    expect(getSkillCapability("anything")).toBeNull();
  });
});

describe("getSkillCapability", () => {
  test("returns null before any seed run", () => {
    expect(getSkillCapability("example-skill-a")).toBeNull();
  });

  test("returns null for unknown ids after seeding", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    expect(getSkillCapability("does-not-exist")).toBeNull();
  });
});
