/**
 * Tests for the v2 skill re-seed sibling call wired into
 * `assistant/src/daemon/handlers/skills.ts`.
 *
 * One representative call site (the `installSkill` bundled branch) is
 * exercised — all 5 sites share the same gate logic, so a single suite
 * covers behavior. Validates:
 *   - flag + config both on    → seedV2SkillEntries invoked after seedSkillGraphNodes
 *   - flag off                  → seedV2SkillEntries not invoked
 *   - config.memory.v2.enabled off (flag on) → seedV2SkillEntries not invoked
 *   - seedV2SkillEntries rejects → handler still returns success
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Programmable test state
// ---------------------------------------------------------------------------

const flagsState = { flagEnabled: true, configV2Enabled: true };

const callOrder: string[] = [];

const mockSeedSkillGraphNodes = mock(() => {
  callOrder.push("v1");
});
const mockSeedV2SkillEntries = mock(async () => {
  callOrder.push("v2");
});

// ---------------------------------------------------------------------------
// Mock modules — must be wired before importing module under test.
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [
    {
      id: "bundled-skill",
      name: "bundled-skill",
      displayName: "Bundled Skill",
      description: "A bundled skill",
      directoryPath: "/tmp/test-bundled/bundled-skill",
      skillFilePath: "/tmp/test-bundled/bundled-skill/SKILL.md",
      source: "bundled" as const,
    },
  ],
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === "memory-v2-enabled") return flagsState.flagEnabled;
    return true;
  },
}));

// Stub both `getConfig` and `loadConfig`. `loadConfig` is reached by code
// paths transitively imported during teardown (e.g. dynamic imports inside
// `oauth2.ts`); leaving it undefined here would break sibling test files
// run in the same Bun process because `mock.module` replacements persist
// across files.
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    memory: { v2: { enabled: flagsState.configV2Enabled } },
  }),
  loadConfig: () => ({
    memory: { v2: { enabled: flagsState.configV2Enabled } },
  }),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => [],
  skillFlagKey: () => null,
}));

mock.module("../skills/clawhub.js", () => ({
  clawhubCheckUpdates: mock(async () => []),
  clawhubInspect: mock(async () => ({})),
  clawhubInspectFile: mock(async () => ({})),
  clawhubInstall: mock(async () => ({ success: true })),
  clawhubSearch: mock(async () => ({ skills: [] })),
  clawhubUpdate: mock(async () => ({ success: true })),
  validateSlug: () => true,
}));

mock.module("../skills/skillssh-registry.js", () => ({
  installExternalSkill: mock(async () => {}),
  resolveSkillSource: () => ({
    owner: "x",
    repo: "y",
    skillSlug: "z",
  }),
  searchSkillsRegistry: mock(async () => []),
  fetchSkillAudits: async () => ({}),
  riskToDisplay: () => "",
  providerDisplayName: () => "",
  formatAuditBadges: () => "",
  githubHeaders: () => ({}),
  findSkillDirInTree: async () => null,
  fetchSkillFromGitHub: async () => null,
  validateSkillSlug: () => {},
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
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

mock.module("../runtime/routes/workspace-utils.js", () => ({
  isTextMimeType: () => true,
  MAX_INLINE_TEXT_SIZE: 1024 * 1024,
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => [],
  getCachedCatalogSync: () => [],
}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: async () => {},
  upsertSkillsIndex: () => {},
  getRepoSkillsDir: () => undefined,
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
}));

mock.module("../skills/managed-store.js", () => ({
  createManagedSkill: () => ({ created: true }),
  deleteManagedSkill: () => ({ deleted: true }),
  removeSkillsIndexEntry: () => {},
  validateManagedSkillId: () => null,
}));

mock.module("../memory/graph/capability-seed.js", () => ({
  deleteSkillCapabilityNode: () => {},
  seedSkillGraphNodes: mockSeedSkillGraphNodes,
  seedUninstalledCatalogSkillMemories: async () => {},
}));

mock.module("../memory/v2/skill-store.js", () => ({
  seedV2SkillEntries: mockSeedV2SkillEntries,
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceSkillsDir: () => "/tmp/test-skills",
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

// Import after mocking
const { installSkill } = await import("../daemon/handlers/skills.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyCtx = {
  debounceTimers: { schedule: () => {} },
  setSuppressConfigReload: () => {},
  updateConfigFingerprint: () => {},
  broadcast: () => {},
} as unknown as Parameters<typeof installSkill>[1];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2 skill re-seed gating in skill handlers", () => {
  beforeEach(() => {
    flagsState.flagEnabled = true;
    flagsState.configV2Enabled = true;
    callOrder.length = 0;
    mockSeedSkillGraphNodes.mockClear();
    mockSeedV2SkillEntries.mockClear();
    mockSeedV2SkillEntries.mockImplementation(async () => {
      callOrder.push("v2");
    });
  });

  test("flag + config both on → seedV2SkillEntries invoked after seedSkillGraphNodes", async () => {
    const result = await installSkill({ slug: "bundled-skill" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(mockSeedSkillGraphNodes).toHaveBeenCalledTimes(1);
    expect(mockSeedV2SkillEntries).toHaveBeenCalledTimes(1);
    // Drain the void-prefixed promise so the call-order assertion can see "v2".
    await Promise.resolve();
    expect(callOrder).toEqual(["v1", "v2"]);
  });

  test("flag off → seedV2SkillEntries is not invoked", async () => {
    flagsState.flagEnabled = false;

    const result = await installSkill({ slug: "bundled-skill" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(mockSeedSkillGraphNodes).toHaveBeenCalledTimes(1);
    expect(mockSeedV2SkillEntries).not.toHaveBeenCalled();
  });

  test("config.memory.v2.enabled off → seedV2SkillEntries is not invoked", async () => {
    flagsState.configV2Enabled = false;

    const result = await installSkill({ slug: "bundled-skill" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(mockSeedSkillGraphNodes).toHaveBeenCalledTimes(1);
    expect(mockSeedV2SkillEntries).not.toHaveBeenCalled();
  });

  test("seedV2SkillEntries rejection does not fail the handler", async () => {
    mockSeedV2SkillEntries.mockImplementation(async () => {
      throw new Error("v2 seed boom");
    });

    const result = await installSkill({ slug: "bundled-skill" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(mockSeedV2SkillEntries).toHaveBeenCalledTimes(1);
    // Drain the rejected promise so it does not surface as an unhandled
    // rejection in subsequent tests.
    await Promise.resolve();
  });
});
