/**
 * Tests for `assistant/src/memory/v2/skill-store.ts`.
 *
 * Coverage matrix:
 *   - `seedV2SkillEntries` enumerates the catalog and calls
 *     `upsertConceptPageEmbedding` with `slug: "skills/<id>"` for each
 *     enabled skill in the unified `memory_v2_concept_pages` collection.
 *   - It skips skills whose declared feature flag is disabled.
 *   - It calls `pruneSlugsWithPrefixExcept("skills/", ...)` with the active
 *     id list as suffixes, so stale skill slugs in the unified collection
 *     get pruned without touching concept-page slugs.
 *   - It populates the `entries` cache so `getSkillCapability` returns each
 *     entry — accepting both bare ids (`"example-skill"`) and unified-collection
 *     slugs (`"skills/example-skill"`).
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
import type { CatalogSkill } from "../../../skills/catalog-install.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// ---------------------------------------------------------------------------
// Programmable test state — drives every mocked dependency below.
// ---------------------------------------------------------------------------

interface UpsertCall {
  slug: string;
  dense: number[];
  sparse: { indices: number[]; values: number[] };
  updatedAt: number;
}

interface PruneCall {
  prefix: string;
  activeSuffixes: readonly string[];
}

interface TestState {
  catalog: SkillSummary[];
  resolved: ResolvedSkill[];
  fullCatalog: CatalogSkill[];
  fullCatalogThrows: Error | null;
  flagsEnabled: Record<string, boolean>;
  embedThrows: Error | null;
  embedReturn: number[][];
  sparseReturn: { indices: number[]; values: number[] };
  upsertCalls: UpsertCall[];
  pruneCalls: PruneCall[];
  upsertThrows: Error | null;
}

const state: TestState = {
  catalog: [],
  resolved: [],
  fullCatalog: [],
  fullCatalogThrows: null,
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

mock.module("../qdrant.js", () => ({
  upsertConceptPageEmbedding: async (params: UpsertCall) => {
    if (state.upsertThrows) throw state.upsertThrows;
    state.upsertCalls.push(params);
  },
  pruneSlugsWithPrefixExcept: async (
    prefix: string,
    activeSuffixes: readonly string[],
  ) => {
    state.pruneCalls.push({ prefix, activeSuffixes });
  },
}));

mock.module("../../../skills/catalog-cache.js", () => ({
  getCatalog: async () => {
    if (state.fullCatalogThrows) throw state.fullCatalogThrows;
    return state.fullCatalog;
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
  state.fullCatalog = [];
  state.fullCatalogThrows = null;
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
  test("upserts each enabled skill into the unified collection under skills/<id>", async () => {
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
    const slugs = state.upsertCalls.map((c) => c.slug).sort();
    expect(slugs).toEqual(["skills/example-skill-a", "skills/example-skill-b"]);

    // Each upsert carries the per-skill dense + sparse + updatedAt payload,
    // keyed under the unified `skills/<id>` slug.
    const callA = state.upsertCalls.find(
      (c) => c.slug === "skills/example-skill-a",
    )!;
    expect(callA.dense).toEqual([0.1, 0.2, 0.3]);
    expect(callA.sparse).toEqual(state.sparseReturn);
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
    expect(state.upsertCalls[0].slug).toBe("skills/example-skill-a");
  });

  test("does not re-seed an installed-but-disabled skill from the remote catalog", async () => {
    // Regression: if `seenIds` is built only from enabled skills, a locally
    // installed-but-disabled skill falls through to the catalog loop and gets
    // embedded as if it were a discoverable uninstalled skill — contradicting
    // the user's explicit disablement.
    const enabledSkill = makeSummary({ id: "example-skill-a" });
    const disabledSkill = makeSummary({ id: "example-skill-b" });
    state.catalog = [enabledSkill, disabledSkill];
    state.resolved = [
      { summary: enabledSkill, state: "enabled" },
      { summary: disabledSkill, state: "disabled" },
    ];
    state.fullCatalog = [
      {
        id: "example-skill-b",
        name: "example-skill-b",
        description: "Disabled skill that also lives in the remote catalog",
      },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].slug).toBe("skills/example-skill-a");
  });

  test("seeds genuinely uninstalled catalog skills alongside enabled installed skills", async () => {
    const installed = makeSummary({ id: "example-skill-a" });
    state.catalog = [installed];
    state.resolved = [{ summary: installed, state: "enabled" }];
    state.fullCatalog = [
      {
        id: "example-skill-a",
        name: "example-skill-a",
        description: "Installed (must not duplicate)",
      },
      {
        id: "uninstalled-skill",
        name: "uninstalled-skill",
        description: "Discoverable from the catalog",
      },
    ];
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2SkillEntries();

    const slugs = state.upsertCalls.map((c) => c.slug).sort();
    expect(slugs).toEqual([
      "skills/example-skill-a",
      "skills/uninstalled-skill",
    ]);
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
    expect(state.upsertCalls[0].slug).toBe("skills/example-skill-b");
  });

  test("calls pruneSlugsWithPrefixExcept with the active id list and the skills/ prefix", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    const skillB = makeSummary({ id: "example-skill-b" });
    state.catalog = [skillA, skillB];
    state.resolved = [
      { summary: skillA, state: "enabled" },
      { summary: skillB, state: "enabled" },
    ];
    // Remote catalog must be non-empty so catalogAvailable is true and
    // pruning is not skipped.
    state.fullCatalog = [
      { id: "example-skill-a", name: "example-skill-a", description: "A" },
      { id: "example-skill-b", name: "example-skill-b", description: "B" },
    ];
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2SkillEntries();

    expect(state.pruneCalls).toHaveLength(1);
    expect(state.pruneCalls[0].prefix).toBe("skills/");
    expect([...state.pruneCalls[0].activeSuffixes].sort()).toEqual([
      "example-skill-a",
      "example-skill-b",
    ]);
  });

  test("passes only the active (post-flag-filter) ids to pruneSlugsWithPrefixExcept", async () => {
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
    state.fullCatalog = [
      { id: "example-skill-a", name: "example-skill-a", description: "A" },
      { id: "example-skill-b", name: "example-skill-b", description: "B" },
    ];
    state.embedReturn = [[0.4, 0.5, 0.6]];

    await seedV2SkillEntries();

    expect(state.pruneCalls).toHaveLength(1);
    expect(state.pruneCalls[0].prefix).toBe("skills/");
    expect([...state.pruneCalls[0].activeSuffixes]).toEqual([
      "example-skill-b",
    ]);
  });

  test("populates the entries cache so getSkillCapability resolves both bare id and unified slug", async () => {
    const skillA = makeSummary({
      id: "example-skill-a",
      displayName: "Skill A",
    });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    expect(getSkillCapability("example-skill-a")).toBeNull();

    await seedV2SkillEntries();

    // Bare id and unified-slug forms both resolve to the same entry.
    const byId = getSkillCapability("example-skill-a");
    const bySlug = getSkillCapability("skills/example-skill-a");
    expect(byId).not.toBeNull();
    expect(byId?.id).toBe("example-skill-a");
    expect(byId?.content).toContain("Skill A");
    expect(bySlug).toEqual(byId);

    expect(getSkillCapability("unknown-skill")).toBeNull();
    expect(getSkillCapability("skills/unknown-skill")).toBeNull();
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

  test("no enabled skills yields empty cache and no prune when catalog is empty", async () => {
    state.catalog = [];
    state.resolved = [];
    // fullCatalog defaults to [] — catalog unavailable, so pruning is skipped.

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(0);
    expect(state.pruneCalls).toHaveLength(0);
    expect(getSkillCapability("anything")).toBeNull();
  });

  test("no enabled skills prunes when catalog is available", async () => {
    state.catalog = [];
    state.resolved = [];
    state.fullCatalog = [
      { id: "remote-only", name: "remote-only", description: "Remote skill" },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].slug).toBe("skills/remote-only");
    expect(state.pruneCalls).toHaveLength(1);
    expect(state.pruneCalls[0].prefix).toBe("skills/");
    expect([...state.pruneCalls[0].activeSuffixes]).toEqual(["remote-only"]);
  });

  test("skips pruning when catalog fetch returns empty (network failure guard)", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.fullCatalog = []; // Simulates cold cache / network failure
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.pruneCalls).toHaveLength(0);
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
