/**
 * Category precedence in toSlimSkillResponse (via listSkills):
 * catalog entry > SKILL.md frontmatter > "system" fallback.
 */
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { CatalogSkill } from "../skills/catalog-install.js";
import type { SkillInstallMeta } from "../skills/install-meta.js";

let mockSummaries: SkillSummary[] = [];
let mockCachedCatalog: CatalogSkill[] = [];
let mockInstallMeta: SkillInstallMeta | null = null;

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
  loadSkillCatalog: () => mockSummaries,
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: (catalog: SkillSummary[]) =>
    catalog.map((summary) => ({ summary, state: "enabled" })),
  skillFlagKey: () => null,
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => mockInstallMeta,
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => mockCachedCatalog,
  getCachedCatalogSync: () => mockCachedCatalog,
}));

mock.module("../skills/catalog-files.js", () => ({
  catalogSkillToSlim: () => ({}),
  createVellumCatalogProvider: () => ({}),
  hasHiddenOrSkippedSegment: () => false,
  readCatalogSkillFiles: async () => null,
  readCatalogSkillFileContent: async () => null,
  sanitizeRelativePath: (p: string) => p,
  SKIP_DIRS: new Set(["node_modules", "__pycache__", ".git"]),
}));

mock.module("../skills/skillssh-files.js", () => ({
  createSkillsShProvider: () => ({}),
}));

mock.module("../skills/clawhub-files.js", () => ({
  createClawhubProvider: () => ({}),
}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: async () => {},
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
  fetchSkillAudits: async () => [],
  installExternalSkill: async () => {},
  resolveSkillSource: () => ({ owner: "", repo: "", skillSlug: "" }),
  searchSkillsRegistry: async () => [],
}));

mock.module("../skills/managed-store.js", () => ({
  createManagedSkill: () => ({ created: true }),
  deleteManagedSkill: () => ({ deleted: true }),
  validateManagedSkillId: () => null,
}));

mock.module("../plugins/defaults/memory/graph/capability-seed.js", () => ({
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
  getWorkspaceSkillsDir: () => "/tmp/test-skills-category",
}));

mock.module("../daemon/handlers/shared.js", () => ({
  CONFIG_RELOAD_DEBOUNCE_MS: 100,
  ensureSkillEntry: () => ({ enabled: false }),
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

import { listSkills } from "../daemon/handlers/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<SkillSummary>): SkillSummary {
  const directoryPath = overrides.directoryPath ?? "/tmp/nonexistent-skill-dir";
  return {
    id: overrides.id ?? "summary-id",
    name: overrides.id ?? "summary-id",
    displayName: overrides.displayName ?? "Summary",
    description: "",
    directoryPath,
    skillFilePath: join(directoryPath, "SKILL.md"),
    source: overrides.source ?? "bundled",
    bundled: overrides.source !== "managed",
    category: overrides.category,
  };
}

function makeCatalogSkill(id: string, category: string): CatalogSkill {
  return {
    id,
    name: id,
    description: "",
    metadata: { vellum: { category } },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listSkills — category precedence", () => {
  test("catalog category wins over frontmatter category", () => {
    mockSummaries = [makeSummary({ id: "gmail", category: "messaging" })];
    mockCachedCatalog = [makeCatalogSkill("gmail", "email")];

    const [skill] = listSkills();
    expect(skill.category).toBe("email");
  });

  test("frontmatter category used when skill is not in the catalog", () => {
    mockSummaries = [makeSummary({ id: "schedule", category: "productivity" })];
    mockCachedCatalog = [];

    const [skill] = listSkills();
    expect(skill.category).toBe("productivity");
  });

  test("falls back to system when neither catalog nor frontmatter declare a category", () => {
    mockSummaries = [makeSummary({ id: "mystery" })];
    mockCachedCatalog = [];

    const [skill] = listSkills();
    expect(skill.category).toBe("system");
  });
});

describe("listSkills — origin derivation", () => {
  test("managed skill authored by the assistant reports the assistant-memory origin", () => {
    mockSummaries = [makeSummary({ id: "retro-note", source: "managed" })];
    mockCachedCatalog = [];
    mockInstallMeta = {
      origin: "custom",
      installedAt: "2026-01-01T00:00:00.000Z",
      author: "assistant",
    };

    const [skill] = listSkills();
    expect(skill.origin).toBe("assistant-memory");
    // Stays an installed (managed) skill so it remains deletable.
    expect(skill.kind).toBe("installed");
  });

  test("managed skill without an assistant author keeps its custom origin", () => {
    mockSummaries = [makeSummary({ id: "hand-rolled", source: "managed" })];
    mockCachedCatalog = [];
    mockInstallMeta = {
      origin: "custom",
      installedAt: "2026-01-01T00:00:00.000Z",
    };

    const [skill] = listSkills();
    expect(skill.origin).toBe("custom");
    expect(skill.kind).toBe("installed");
  });

  // An install-meta.json origin outside the known set degrades to "custom", and
  // every listSkills() entry is a defined response.
  test("managed skill with an unknown origin degrades to custom, never undefined", () => {
    mockSummaries = [makeSummary({ id: "weird-origin", source: "managed" })];
    mockCachedCatalog = [];
    mockInstallMeta = {
      origin: "some-unhandled-origin" as never,
      installedAt: "2026-01-01T00:00:00.000Z",
    };

    const skills = listSkills();
    expect(skills.every((s) => s !== undefined)).toBe(true);
    expect(skills[0].origin).toBe("custom");
  });
});
