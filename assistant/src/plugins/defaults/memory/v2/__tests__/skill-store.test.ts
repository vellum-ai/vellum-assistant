/**
 * Tests for `assistant/src/memory/v2/skill-store.ts`.
 *
 * Coverage matrix:
 *   - `seedV2SkillEntries` enumerates the catalog and calls
 *     `upsertConceptPageEmbedding` with `slug: "skills/<id>"` for each
 *     enabled skill in the unified `memory_v2_concept_pages` collection.
 *   - It skips skills the host resolves as flag-gated (state
 *     "unavailable") — installed and remote alike.
 *   - It calls `pruneSlugsWithPrefixExcept("skills/", ...)` with the active
 *     id list as suffixes, so stale skill slugs in the unified collection
 *     get pruned without touching concept-page slugs.
 *   - It populates the `entries` cache so `getSkillCapability` returns each
 *     entry — accepting both bare ids (`"example-skill"`) and unified-collection
 *     slugs (`"skills/example-skill"`).
 *   - It swallows errors from the embedding backend — the function resolves
 *     and the cache is unchanged from prior state.
 *
 * Hermetic by design: the embedding backend, Qdrant module, and feature-flag
 * resolver are module-mocked so the suite never reaches a real backend. One
 * regression case uses a temp workspace to exercise disk-discovered skills.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ResolvedSkill } from "../../../../../config/skill-state.js";
import type { SkillSummary } from "../../../../../config/skills.js";
import type { CatalogSkill } from "../../../../../skills/catalog-install.js";

// ---------------------------------------------------------------------------
// Programmable test state — drives every mocked dependency below.
// ---------------------------------------------------------------------------

interface UpsertCall {
  slug: string;
  dense: number[];
  sparse: { indices: number[]; values: number[] };
  updatedAt: number;
  kind?: string;
}

interface PruneCall {
  prefix: string;
  activeSuffixes: readonly string[];
  options?: { kind?: string };
}

interface BackfillCall {
  prefix: string;
  kind: string;
  allowedSuffixes: ReadonlySet<string>;
}

interface TestState {
  catalog: SkillSummary[] | null;
  resolved: ResolvedSkill[] | null;
  fullCatalog: CatalogSkill[];
  fullCatalogThrows: Error | null;
  flagsEnabled: Record<string, boolean>;
  embedThrows: Error | null;
  embedReturn: number[][];
  sparseReturn: { indices: number[]; values: number[] };
  upsertCalls: UpsertCall[];
  pruneCalls: PruneCall[];
  upsertThrows: Error | null;
  backfillCalls: BackfillCall[];
  backfillReturn: number;
  backfillThrows: Error | null;
  callSequence: Array<"upsert" | "prune" | "backfill">;
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
  backfillCalls: [],
  backfillReturn: 0,
  backfillThrows: null,
  callSequence: [],
};

// Stub config so resolveSkillStates / mcp augmentation have something to read.
mock.module("../../../../../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      qdrant: { url: "http://127.0.0.1:6333", vectorSize: 3, onDisk: false },
    },
    mcp: { servers: {} },
    skills: { entries: {}, allowBundled: [] },
  }),
}));

mock.module("../../../../../config/skills.js", () => ({
  loadSkillCatalog: () => state.catalog ?? [],
}));

mock.module("../../../../../config/skill-state.js", () => ({
  resolveSkillStates: (
    catalog: SkillSummary[],
    config: { skills?: { allowBundled?: string[] | null } },
  ) => {
    if (state.resolved) {
      return state.resolved;
    }
    return catalog
      .filter((summary) => {
        const allowBundled = config.skills?.allowBundled;
        return !(
          summary.source === "bundled" &&
          allowBundled != null &&
          !allowBundled.includes(summary.id)
        );
      })
      .map((summary) => ({
        summary,
        state:
          summary.source === "managed" ||
          summary.source === "bundled" ||
          summary.source === "plugin"
            ? "enabled"
            : "disabled",
      }));
  },
}));

mock.module("../../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    state.flagsEnabled[key] ?? true,
}));

mock.module(
  "../../../../../persistence/embeddings/embedding-backend.js",
  () => ({
    embedWithBackend: async (_config: unknown, inputs: unknown[]) => {
      if (state.embedThrows) {
        throw state.embedThrows;
      }
      // Echo the configured per-call vectors back, padded if needed.
      const vectors = state.embedReturn.length
        ? state.embedReturn
        : inputs.map(() => [0.1, 0.2, 0.3]);
      return { provider: "local", model: "test-model", vectors };
    },
    generateSparseEmbedding: () => state.sparseReturn,
  }),
);

mock.module("../qdrant.js", () => ({
  upsertConceptPageEmbedding: async (params: UpsertCall) => {
    if (state.upsertThrows) {
      throw state.upsertThrows;
    }
    state.callSequence.push("upsert");
    state.upsertCalls.push(params);
  },
  pruneSlugsWithPrefixExcept: async (
    prefix: string,
    activeSuffixes: readonly string[],
    options?: { kind?: string },
  ) => {
    state.callSequence.push("prune");
    state.pruneCalls.push({ prefix, activeSuffixes, options });
  },
  backfillKindOnPointsWithPrefix: async (
    prefix: string,
    kind: string,
    allowedSuffixes: ReadonlySet<string>,
  ) => {
    if (state.backfillThrows) {
      throw state.backfillThrows;
    }
    state.callSequence.push("backfill");
    state.backfillCalls.push({ prefix, kind, allowedSuffixes });
    return state.backfillReturn;
  },
}));

mock.module("../../../../../skills/catalog-cache.js", () => ({
  getCatalog: async () => {
    if (state.fullCatalogThrows) {
      throw state.fullCatalogThrows;
    }
    return state.fullCatalog;
  },
}));

// Imported AFTER all mocks are wired so the module under test sees the stubs.
const {
  seedV2SkillEntries,
  getSkillCapability,
  listSkillEntries,
  _resetSkillStoreForTests,
} = await import("../skill-store.js");

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
  state.backfillCalls.length = 0;
  state.backfillReturn = 0;
  state.backfillThrows = null;
  state.callSequence.length = 0;
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
    // Flag gating is resolved host-side: `resolveSkillStates` drops the
    // flagged skill from its result, so it reaches the seed loop as
    // `state: "unavailable"` and must not be embedded.
    const flagged = makeSummary({
      id: "example-skill-a",
      featureFlag: "experimental-flag",
    });
    const unflagged = makeSummary({ id: "example-skill-b" });
    state.catalog = [flagged, unflagged];
    state.resolved = [{ summary: unflagged, state: "enabled" }];
    state.embedReturn = [[0.4, 0.5, 0.6]];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].slug).toBe("skills/example-skill-b");
  });

  test("does not seed remote catalog skills whose feature flag is disabled but keeps their ids in the backfill allowlist", async () => {
    state.catalog = [];
    state.resolved = [];
    state.fullCatalog = [
      {
        id: "gated-remote",
        name: "gated-remote",
        description: "Remote skill behind a disabled flag",
        metadata: { vellum: { "feature-flag": "off-flag" } },
      },
      { id: "open-remote", name: "open-remote", description: "Open remote" },
    ];
    state.flagsEnabled = { "off-flag": false };
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    // Only the ungated remote skill is embedded...
    expect(state.upsertCalls.map((c) => c.slug)).toEqual([
      "skills/open-remote",
    ]);
    // ...but the gated id stays in the known-skill allowlist so the legacy
    // kind backfill never mis-tags (and prune never deletes) a user page
    // that happens to share its slug.
    expect(state.backfillCalls).toHaveLength(1);
    expect([...state.backfillCalls[0].allowedSuffixes].sort()).toEqual([
      "gated-remote",
      "open-remote",
    ]);
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
    state.resolved = [{ summary: unflagged, state: "enabled" }];
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

  test("skips stale in-flight seed results when a newer refresh is requested", async () => {
    const skillA = makeSummary({
      id: "example-skill-a",
      displayName: "Skill A",
    });
    const skillB = makeSummary({
      id: "example-skill-b",
      displayName: "Skill B",
    });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    const firstSeed = seedV2SkillEntries();
    state.catalog = [skillB];
    state.resolved = [{ summary: skillB, state: "enabled" }];
    const secondSeed = seedV2SkillEntries();

    await Promise.all([firstSeed, secondSeed]);

    expect(state.upsertCalls.map((call) => call.slug)).toEqual([
      "skills/example-skill-b",
    ]);
    expect(getSkillCapability("example-skill-a")).toBeNull();
    expect(getSkillCapability("example-skill-b")?.content).toContain("Skill B");
  });

  test("continues draining when waiter continuations enqueue additional generations", async () => {
    const skillA = makeSummary({
      id: "example-skill-a",
      displayName: "Skill A",
    });
    const skillB = makeSummary({
      id: "example-skill-b",
      displayName: "Skill B",
    });
    const skillC = makeSummary({
      id: "example-skill-c",
      displayName: "Skill C",
    });

    function useSkill(skill: SkillSummary, dense: number[]): void {
      state.catalog = [skill];
      state.resolved = [{ summary: skill, state: "enabled" }];
      state.embedReturn = [dense];
    }

    useSkill(skillA, [0.1, 0.2, 0.3]);
    const firstSeed = seedV2SkillEntries();
    const secondSeed = firstSeed.then(() => {
      useSkill(skillB, [0.4, 0.5, 0.6]);
      return seedV2SkillEntries();
    });
    const thirdSeed = secondSeed.then(() => {
      useSkill(skillC, [0.7, 0.8, 0.9]);
      return seedV2SkillEntries();
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          Promise.all([firstSeed, secondSeed, thirdSeed]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("seed queue stalled")),
              500,
            );
          }),
        ]),
      ).resolves.toBeDefined();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    expect(state.upsertCalls.map((call) => call.slug)).toEqual([
      "skills/example-skill-a",
      "skills/example-skill-b",
      "skills/example-skill-c",
    ]);
    expect(getSkillCapability("example-skill-a")).toBeNull();
    expect(getSkillCapability("example-skill-b")).toBeNull();
    expect(getSkillCapability("example-skill-c")?.content).toContain("Skill C");
  });

  test("seeds disk-discovered managed skills omitted from a stale SKILLS.md index", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "skill-store-index-"));
    state.resolved = null;
    state.embedReturn = [[0.7, 0.8, 0.9]];

    try {
      const skillsDir = join(workspaceDir, "skills");
      const skillDir = join(skillsDir, "geo-article-writer");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillsDir, "SKILLS.md"), "- stale-only\n", "utf-8");
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---
name: "Geo Article Writer"
description: "Writes local geo articles"
metadata:
  vellum:
    activation-hints:
      - user asks for local article drafts
    avoid-when:
      - user only wants citation extraction
---

Write a local article draft.
`,
        "utf-8",
      );

      state.catalog = [
        {
          id: "geo-article-writer",
          name: "Geo Article Writer",
          displayName: "Geo Article Writer",
          description: "Writes local geo articles",
          directoryPath: skillDir,
          skillFilePath: join(skillDir, "SKILL.md"),
          source: "managed",
          activationHints: ["user asks for local article drafts"],
          avoidWhen: ["user only wants citation extraction"],
        },
      ];

      await seedV2SkillEntries();
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].slug).toBe("skills/geo-article-writer");

    const entry = getSkillCapability("geo-article-writer");
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("geo-article-writer");
    expect(entry?.content).toContain('The "Geo Article Writer" skill');
    expect(entry?.content).toContain("Writes local geo articles");
    expect(entry?.content).toContain(
      "Use when: user asks for local article drafts.",
    );
    expect(entry?.content).toContain(
      "Avoid when: user only wants citation extraction.",
    );
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

  test("populates the cache from the local catalog on the first seed even when the embedding backend is unavailable (cold-start needle resilience)", async () => {
    // Regression: on a brand-new managed assistant the startup seed runs before
    // the platform provisions the managed embedding credential, so the very
    // first `embedWithBackend` throws. The in-memory cache (which the v3 needle
    // lane and the page index read) must still populate from the local catalog
    // so skills are discoverable from first boot; only the dense Qdrant upsert
    // is deferred until the backend recovers.
    const skillA = makeSummary({
      id: "example-skill-a",
      displayName: "Skill A",
    });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    // No prior successful seed — the backend is unconfigured from the start.
    state.embedThrows = new Error(
      'Embedding backend "gemini" is not configured',
    );

    // Best-effort callers (the startup seed) must resolve.
    await expect(seedV2SkillEntries()).resolves.toBeUndefined();

    // The needle-lane cache is populated despite the dense-embed failure.
    const entry = getSkillCapability("example-skill-a");
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("example-skill-a");
    expect(entry?.content).toContain("Skill A");
    expect(listSkillEntries().map((e) => e.id)).toEqual(["example-skill-a"]);

    // No dense vectors were produced, so the Qdrant write is skipped entirely.
    expect(state.upsertCalls).toHaveLength(0);
    expect(state.pruneCalls).toHaveLength(0);
  });

  test("surfaces the dense-embed failure to throwOnError callers while still populating the needle cache", async () => {
    // The managed-credential reseed and the operator reembed route pass
    // `throwOnError` so they learn the dense lane didn't complete and the
    // retry/maintain machinery backfills it — but the needle cache is fixed
    // regardless before the error propagates.
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedThrows = new Error("backend down");

    await expect(seedV2SkillEntries({ throwOnError: true })).rejects.toThrow(
      "backend down",
    );

    expect(getSkillCapability("example-skill-a")).not.toBeNull();
    expect(state.upsertCalls).toHaveLength(0);
  });

  test("drops a locally-disabled installed skill even when the catalog is unavailable (local state is authoritative)", async () => {
    // Regression: the local resolution is authoritative, so a skill that is
    // still installed but explicitly disabled must NOT be kept alive by remote-
    // catalog uncertainty — `getSkillCapability` and the page index must drop it.
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.fullCatalog = [
      { id: "example-skill-a", name: "example-skill-a", description: "A" },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    // First run: skillA enabled and cached.
    await seedV2SkillEntries();
    expect(getSkillCapability("example-skill-a")).not.toBeNull();

    // Second run: skillA is still locally installed but now disabled; the remote
    // catalog is unavailable. It stays in `installedIds`, so the carry-forward
    // must skip it and the cache drops it.
    state.resolved = [{ summary: skillA, state: "disabled" }];
    state.fullCatalog = [];
    state.fullCatalogThrows = new Error("catalog fetch failed");

    await seedV2SkillEntries();

    expect(getSkillCapability("example-skill-a")).toBeNull();
    expect(listSkillEntries()).toEqual([]);
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

  test("passes kind: 'skill' to upsert and prune so legacy skill rows stay scoped to the skill kind", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.fullCatalog = [
      { id: "example-skill-a", name: "example-skill-a", description: "A" },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].kind).toBe("skill");
    expect(state.pruneCalls).toHaveLength(1);
    expect(state.pruneCalls[0].options).toEqual({ kind: "skill" });
  });

  test("runs the legacy kind backfill before pruning so kindless skill points become prunable", async () => {
    // Simulates an install carrying legacy skill points written before the
    // kind discriminator existed: the backfill must run before prune so the
    // kind-scoped prune can see and delete the orphans.
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.fullCatalog = [
      { id: "example-skill-a", name: "example-skill-a", description: "A" },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];
    state.backfillReturn = 3;

    await seedV2SkillEntries();

    expect(state.backfillCalls).toHaveLength(1);
    expect(state.backfillCalls[0].prefix).toBe("skills/");
    expect(state.backfillCalls[0].kind).toBe("skill");
    expect([...state.backfillCalls[0].allowedSuffixes].sort()).toEqual([
      "example-skill-a",
    ]);
    expect(state.pruneCalls).toHaveLength(1);
    expect(state.pruneCalls[0].options).toEqual({ kind: "skill" });
    expect(state.callSequence.filter((s) => s !== "upsert")).toEqual([
      "backfill",
      "prune",
    ]);
  });

  test("backfill only runs once per process across repeated seed runs", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.fullCatalog = [
      { id: "example-skill-a", name: "example-skill-a", description: "A" },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();
    expect(state.backfillCalls).toHaveLength(1);

    // A second seed should not re-scan: new upserts already carry kind, so
    // there's nothing for the backfill to do.
    state.embedReturn = [[0.1, 0.2, 0.3]];
    await seedV2SkillEntries();
    expect(state.backfillCalls).toHaveLength(1);
    expect(state.pruneCalls).toHaveLength(2);
  });

  test("backfill failure is non-fatal — prune still runs and lastSeedError stays clean", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.fullCatalog = [
      { id: "example-skill-a", name: "example-skill-a", description: "A" },
    ];
    state.embedReturn = [[0.1, 0.2, 0.3]];
    state.backfillThrows = new Error("qdrant scroll exploded");

    await expect(
      seedV2SkillEntries({ throwOnError: true }),
    ).resolves.toBeUndefined();

    // Prune still ran despite the backfill failure — we don't want to block
    // the steady-state prune when the legacy scan trips.
    expect(state.pruneCalls).toHaveLength(1);
  });

  test("backfill allowlist spans installed + remote catalog ids so user-authored skills/* pages stay untagged", async () => {
    // Regression: backfilling kind on every `skills/*` point would also tag
    // user-authored concept pages slugged like `skills/my-notes` — those
    // would then be pruned as stale skills. The allowlist must contain
    // every legitimate skill id we know about (installed + remote catalog)
    // and nothing else.
    const installed = makeSummary({ id: "installed-skill" });
    state.catalog = [installed];
    state.resolved = [{ summary: installed, state: "enabled" }];
    state.fullCatalog = [
      { id: "installed-skill", name: "installed-skill", description: "X" },
      { id: "remote-only-skill", name: "remote-only-skill", description: "Y" },
    ];
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2SkillEntries();

    expect(state.backfillCalls).toHaveLength(1);
    expect([...state.backfillCalls[0].allowedSuffixes].sort()).toEqual([
      "installed-skill",
      "remote-only-skill",
    ]);
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

  test("mutating the returned entry does not corrupt the cache", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    const first = getSkillCapability("example-skill-a");
    expect(first).not.toBeNull();
    const originalContent = first!.content;

    // Frozen entries throw in strict mode when mutated; suppress so we can
    // prove cache invariance even if a future refactor swaps freeze for a
    // plain clone.
    try {
      (first as unknown as { id: string }).id = "tampered";
      (first as unknown as { content: string }).content = "tampered";
    } catch {
      // expected under Object.freeze
    }

    const second = getSkillCapability("example-skill-a");
    expect(second?.id).toBe("example-skill-a");
    expect(second?.content).toBe(originalContent);

    // listSkillEntries path also unaffected.
    const viaList = listSkillEntries();
    expect(viaList[0].id).toBe("example-skill-a");
    expect(viaList[0].content).toBe(originalContent);
  });
});

describe("listSkillEntries", () => {
  test("returns [] when the cache is empty (pre-seed)", () => {
    expect(listSkillEntries()).toEqual([]);
  });

  test("returns entries sorted by id after seeding", async () => {
    // Insert in non-sorted order to prove the sort happens on read.
    const skillB = makeSummary({ id: "example-skill-b" });
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillB, skillA];
    state.resolved = [
      { summary: skillB, state: "enabled" },
      { summary: skillA, state: "enabled" },
    ];
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2SkillEntries();

    const list = listSkillEntries();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.id)).toEqual([
      "example-skill-a",
      "example-skill-b",
    ]);
  });

  test("mutating the returned array does not affect subsequent calls", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    const first = listSkillEntries();
    expect(first).toHaveLength(1);
    first.length = 0;
    first.push({ id: "injected", content: "junk" });

    const second = listSkillEntries();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("example-skill-a");
  });

  test("mutating a returned entry does not corrupt the cache", async () => {
    const skillA = makeSummary({ id: "example-skill-a" });
    state.catalog = [skillA];
    state.resolved = [{ summary: skillA, state: "enabled" }];
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2SkillEntries();

    const first = listSkillEntries();
    expect(first).toHaveLength(1);
    const originalContent = first[0].content;

    // Frozen entries throw in strict mode (ESM tests are strict) when
    // mutated; suppress so we can prove cache invariance even if a future
    // refactor swaps freeze for a plain clone.
    try {
      (first[0] as { id: string }).id = "tampered";
      (first[0] as { content: string }).content = "tampered";
    } catch {
      // expected under Object.freeze
    }

    const second = listSkillEntries();
    expect(second[0].id).toBe("example-skill-a");
    expect(second[0].content).toBe(originalContent);

    // Lookup-by-id path also unaffected.
    const viaLookup = getSkillCapability("example-skill-a");
    expect(viaLookup?.content).toBe(originalContent);
  });
});
