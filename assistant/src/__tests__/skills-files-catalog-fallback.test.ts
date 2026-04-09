/**
 * Tests for `getSkillFiles` catalog fallback.
 *
 * When a skill id isn't resolvable via `findSkillById` (i.e. not installed
 * locally, not bundled, not a managed skill), `getSkillFiles` falls back to
 * the Vellum catalog via `readCatalogSkillFiles`. Catalog fallback entries
 * carry `content: null` because the catalog-files helper defers content
 * fetching to a follow-up per-file endpoint. When a skill IS resolved by
 * `findSkillById` but its on-disk directory is missing, `getSkillFiles`
 * returns a 404 without falling through to the catalog so the listing and
 * detail responses agree on `isInstalled`.
 *
 * Coverage:
 *   - Uninstalled catalog skill: returns `{ skill: catalog/vellum/available, files }` with `content: null` for every entry.
 *   - Neither installed nor in catalog: returns 404.
 *   - Installed skill: preserves the disk-read behavior with inline `content`.
 *   - Installed skill with missing directory: returns 404 without consulting the catalog.
 *   - `catalogSkillToSlim` mapping: `metadata.vellum["display-name"]` wins over `cs.name`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { SkillFileEntry } from "../skills/catalog-files.js";
import type { CatalogSkill } from "../skills/catalog-install.js";

// ---------------------------------------------------------------------------
// Mock state — mutated by individual tests via reset helpers below
// ---------------------------------------------------------------------------

type ResolvedSkillEntry = {
  summary: SkillSummary;
  state: "enabled" | "disabled";
};

let mockResolvedStates: ResolvedSkillEntry[] = [];
let mockCatalog: CatalogSkill[] = [];
let mockCatalogFiles: SkillFileEntry[] | null = null;
const catalogFilesCalls: string[] = [];

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => mockResolvedStates,
  skillFlagKey: () => null,
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => mockCatalog,
}));

mock.module("../skills/catalog-files.js", () => ({
  readCatalogSkillFiles: async (skillId: string) => {
    catalogFilesCalls.push(skillId);
    return mockCatalogFiles;
  },
}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: async () => {},
  upsertSkillsIndex: () => {},
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
}));

mock.module("../skills/clawhub.js", () => ({
  clawhubCheckUpdates: async () => [],
  clawhubInspect: async () => ({}),
  clawhubInstall: async () => ({ success: true }),
  clawhubSearch: async () => ({ skills: [] }),
  clawhubUpdate: async () => ({ success: true }),
}));

mock.module("../skills/skillssh-registry.js", () => ({
  installExternalSkill: async () => {},
  resolveSkillSource: () => ({ owner: "", repo: "", skillSlug: "" }),
  searchSkillsRegistry: async () => [],
}));

mock.module("../skills/managed-store.js", () => ({
  createManagedSkill: () => ({ created: true }),
  deleteManagedSkill: () => ({ deleted: true }),
  removeSkillsIndexEntry: () => {},
  validateManagedSkillId: () => null,
}));

mock.module("../memory/graph/capability-seed.js", () => ({
  deleteSkillCapabilityNode: () => {},
  seedSkillGraphNodes: () => {},
  seedUninstalledCatalogSkillMemories: async () => {},
}));

mock.module("../providers/provider-send-message.js", () => ({
  createTimeout: () => ({
    signal: AbortSignal.timeout(1000),
    cleanup: () => {},
  }),
  extractText: () => "",
  getConfiguredProvider: async () => null,
  userMessage: () => ({}),
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceSkillsDir: () => "/tmp/test-skills-fallback",
}));

mock.module("../daemon/handlers/shared.js", () => ({
  CONFIG_RELOAD_DEBOUNCE_MS: 100,
  ensureSkillEntry: (_raw: Record<string, unknown>, _id: string) => ({
    enabled: false,
  }),
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getSkillFiles } from "../daemon/handlers/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyCtx = {
  debounceTimers: { schedule: () => {} },
  setSuppressConfigReload: () => {},
  updateConfigFingerprint: () => {},
  broadcast: () => {},
} as unknown as Parameters<typeof getSkillFiles>[1];

function makeSummary(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: overrides.id ?? "summary-id",
    name: overrides.name ?? "summary-id",
    displayName: overrides.displayName ?? "Summary",
    description: overrides.description ?? "",
    directoryPath: overrides.directoryPath ?? "/tmp/nonexistent-skill-dir",
    skillFilePath:
      overrides.skillFilePath ??
      join(overrides.directoryPath ?? "/tmp/nonexistent-skill-dir", "SKILL.md"),
    source: overrides.source ?? "workspace",
    bundled: overrides.bundled,
    icon: overrides.icon,
    emoji: overrides.emoji,
    toolManifest: overrides.toolManifest,
    includes: overrides.includes,
    featureFlag: overrides.featureFlag,
    activationHints: overrides.activationHints,
    avoidWhen: overrides.avoidWhen,
    inlineCommandExpansions: overrides.inlineCommandExpansions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSkillFiles — catalog fallback", () => {
  beforeEach(() => {
    mockResolvedStates = [];
    mockCatalog = [];
    mockCatalogFiles = null;
    catalogFilesCalls.length = 0;
  });

  test("returns catalog skill with files (content: null) when skill is uninstalled but present in catalog", async () => {
    mockCatalog = [
      {
        id: "acme-seo",
        name: "acme-seo",
        description: "SEO helper",
        emoji: "\u{1F50D}",
        metadata: { vellum: { "display-name": "Acme SEO" } },
      },
    ];
    mockCatalogFiles = [
      {
        path: "SKILL.md",
        name: "SKILL.md",
        size: 42,
        mimeType: "",
        isBinary: false,
        content: null,
      },
      {
        path: "assets/logo.png",
        name: "logo.png",
        size: 1024,
        mimeType: "",
        isBinary: true,
        content: null,
      },
    ];

    const result = await getSkillFiles("acme-seo", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.skill).toEqual({
      id: "acme-seo",
      name: "Acme SEO",
      description: "SEO helper",
      emoji: "\u{1F50D}",
      kind: "catalog",
      origin: "vellum",
      status: "available",
    });
    expect(result.files).toHaveLength(2);
    for (const entry of result.files) {
      expect(entry.content).toBeNull();
    }
    // Files should be sorted by path via localeCompare (not codepoint) —
    // so "assets/logo.png" sorts before "SKILL.md" under default collation.
    expect(result.files.map((f) => f.path)).toEqual(
      [...result.files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)),
    );
    expect(new Set(result.files.map((f) => f.path))).toEqual(
      new Set(["SKILL.md", "assets/logo.png"]),
    );
    expect(catalogFilesCalls).toEqual(["acme-seo"]);
  });

  test("returns 404 when skill is neither installed nor in the catalog", async () => {
    mockResolvedStates = [];
    mockCatalog = [];

    const result = await getSkillFiles("ghost-skill", dummyCtx);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("ghost-skill");
    expect(catalogFilesCalls).toEqual([]);
  });

  test("returns 404 when skill is in catalog but readCatalogSkillFiles returns null", async () => {
    mockCatalog = [
      {
        id: "broken-skill",
        name: "broken-skill",
        description: "",
      },
    ];
    mockCatalogFiles = null;

    const result = await getSkillFiles("broken-skill", dummyCtx);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("broken-skill");
  });

  test("installed skill returns inline disk content (no catalog call)", async () => {
    // Create a real temp directory for the installed-skill path to read.
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "vellum-skill-files-test-"),
    );
    const installedDir = join(workspaceRoot, "installed-skill");
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, "SKILL.md"),
      "# Installed\n\nBody of the installed skill.",
    );
    writeFileSync(
      join(installedDir, "notes.txt"),
      "Some notes about the skill.",
    );

    try {
      mockResolvedStates = [
        {
          summary: makeSummary({
            id: "installed-skill",
            name: "installed-skill",
            displayName: "Installed Skill",
            description: "A pre-installed skill",
            directoryPath: installedDir,
            source: "workspace",
          }),
          state: "enabled",
        },
      ];

      const result = await getSkillFiles("installed-skill", dummyCtx);

      expect("error" in result).toBe(false);
      if ("error" in result) return;

      // Catalog fallback should NOT have been consulted for an installed skill.
      expect(catalogFilesCalls).toEqual([]);

      expect(result.files).toHaveLength(2);
      const skillMd = result.files.find((f) => f.path === "SKILL.md");
      const notes = result.files.find((f) => f.path === "notes.txt");
      expect(skillMd).toBeDefined();
      expect(notes).toBeDefined();
      expect(skillMd!.content).toBe(
        "# Installed\n\nBody of the installed skill.",
      );
      expect(notes!.content).toBe("Some notes about the skill.");

      // Sort-by-path behavior (localeCompare order) is preserved.
      expect(result.files.map((f) => f.path)).toEqual(
        [...result.files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns 404 without catalog fallback when installed skill directory is missing on disk", async () => {
    // `findSkillById` resolves the skill (resolver lists it as installed)
    // but the on-disk directoryPath does not exist — simulates a corrupted
    // install, mid-delete race, or external unmount. The handler must
    // return 404 so the listing response (`kind: "installed"`) and the
    // detail response stay consistent; falling through to the catalog
    // would flip the detail to `kind: "catalog"` and break the
    // client-side `isInstalled` contract.
    mockResolvedStates = [
      {
        summary: makeSummary({
          id: "ghost-installed",
          name: "ghost-installed",
          displayName: "Ghost Installed",
          description: "Installed in resolver but directory is gone",
          directoryPath: "/tmp/definitely-does-not-exist-" + Date.now(),
          source: "workspace",
        }),
        state: "enabled",
      },
    ];
    // Even if the same id is present in the catalog, the handler must NOT
    // fall through — return 404 instead to avoid masking the missing
    // install directory with a catalog response.
    mockCatalog = [
      {
        id: "ghost-installed",
        name: "ghost-installed",
        description: "Also present in catalog",
      },
    ];
    mockCatalogFiles = [
      {
        path: "SKILL.md",
        name: "SKILL.md",
        size: 10,
        mimeType: "",
        isBinary: false,
        content: null,
      },
    ];

    const result = await getSkillFiles("ghost-installed", dummyCtx);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("ghost-installed");
    expect(result.error).toContain("directory missing");
    // Catalog fallback must not have been consulted.
    expect(catalogFilesCalls).toEqual([]);
  });

  test("catalogSkillToSlim falls back to cs.name when metadata.vellum.display-name is absent", async () => {
    mockCatalog = [
      {
        id: "plain-skill",
        name: "plain-skill",
        description: "Minimal",
      },
    ];
    mockCatalogFiles = [];

    const result = await getSkillFiles("plain-skill", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.skill.name).toBe("plain-skill");
    expect(result.skill.kind).toBe("catalog");
    expect(result.skill.origin).toBe("vellum");
    expect(result.skill.status).toBe("available");
  });

  test("catalogSkillToSlim prefers metadata.vellum.display-name over cs.name", async () => {
    mockCatalog = [
      {
        id: "fancy-skill",
        name: "raw-fancy-name",
        description: "",
        metadata: { vellum: { "display-name": "Pretty Fancy Name" } },
      },
    ];
    mockCatalogFiles = [];

    const result = await getSkillFiles("fancy-skill", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.skill.name).toBe("Pretty Fancy Name");
  });
});

// ---------------------------------------------------------------------------
// Cleanup: ensure we don't leak temp dirs if a test fails mid-way.
// ---------------------------------------------------------------------------

afterEach(() => {
  // Nothing to clean up outside test scope — temp dirs are cleaned per-test.
});
