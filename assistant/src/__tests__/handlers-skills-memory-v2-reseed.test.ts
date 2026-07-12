/**
 * Tests for the v2 skill re-seed sibling call wired into
 * `assistant/src/daemon/handlers/skills.ts`.
 *
 * One representative call site (the `installSkill` bundled branch) is
 * exercised; all handler seed sites share the same delegation to
 * `refreshSkillCapabilityMemories`, so a single suite covers behavior. Validates:
 *   - handler invokes the centralized refresh helper with the live config.
 *
 * The helper's gate semantics (flag + config + rejection swallowing) are
 * covered by `lifecycle-memory-v2-seed.test.ts`; here we only verify that the
 * handler delegates to the centralized refresh path synchronously.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Programmable test state
// ---------------------------------------------------------------------------

const mockRefreshSkillCapabilityMemories = mock(
  (_config: { memory: { v2: { enabled: boolean } } }) => {},
);

// Programmable so the updateSkill success/failure branches can be exercised.
const mockClawhubUpdate = mock(
  async (_skillId: string): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  }),
);

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
  clawhubUpdate: mockClawhubUpdate,
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
  ContextOverflowError: class extends Error {},
  isContextOverflowError: () => false,
  resolveConfiguredProvider: async () => null,
  getConfiguredProvider: async () => null,
  createTimeout: () => ({
    signal: AbortSignal.timeout(1000),
    cleanup: () => {},
  }),
  extractText: () => "",
  extractAllText: () => "",
  extractToolUse: () => [],
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
  commitStagedSkillInstall: () => {},
  createSkillInstallStagingDir: () => "/tmp/test-skills/.install-staging/test",
  getRepoSkillsDir: () => undefined,
  installSkillDependenciesIfPresent: () => {},
  installSkillLocally: async () => {},
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
}));

mock.module("../skills/managed-store.js", () => ({
  createManagedSkill: () => ({ created: true }),
  deleteManagedSkill: () => ({ deleted: true }),
  validateManagedSkillId: () => null,
}));

mock.module("../plugins/defaults/memory/graph/capability-seed.js", () => ({
  deleteSkillCapabilityNode: () => {},
}));

mock.module("../daemon/skill-memory-refresh.js", () => ({
  refreshSkillCapabilityMemories: mockRefreshSkillCapabilityMemories,
}));

// Keep the real platform module (the config loader resolves the workspace
// config path through it) and only pin the skills directory.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
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

mock.module("../daemon/config-watcher.js", () => ({
  ConfigWatcher: class {},
  getConfigWatcher: () => ({
    suppressConfigReload: false,
    timers: { schedule: (_k: string, _ms: number, fn: () => void) => fn() },
    updateFingerprint: () => {},
  }),
  cleanupSettingsChanged: () => false,
}));

// Import after mocking
const { installSkill, uninstallSkill, updateSkill } =
  await import("../daemon/handlers/skills.js");
const { setConfig } = await import("./helpers/set-config.js");

/** Seed `memory.v2.enabled` into the workspace config for real. */
function seedMemoryV2(enabled: boolean): void {
  setConfig("memory", { v2: { enabled } });
}

/** The `memory.v2.enabled` value from the config a handler passed along. */
function refreshCallV2Enabled(callIndex: number): boolean | undefined {
  return mockRefreshSkillCapabilityMemories.mock.calls[callIndex]?.[0]?.memory
    ?.v2?.enabled;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2 skill refresh delegation in skill handlers", () => {
  beforeEach(() => {
    seedMemoryV2(true);
    mockRefreshSkillCapabilityMemories.mockClear();
    mockClawhubUpdate.mockReset();
    mockClawhubUpdate.mockImplementation(async () => ({ success: true }));
  });

  test("enabled config → refresh helper invoked with live config", async () => {
    const result = await installSkill({ slug: "bundled-skill" });

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(refreshCallV2Enabled(0)).toBe(true);
  });

  test("config.memory.v2.enabled off → helper receives disabled config", async () => {
    seedMemoryV2(false);

    const result = await installSkill({ slug: "bundled-skill" });

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(refreshCallV2Enabled(0)).toBe(false);
  });

  test("uninstall delegates to refresh helper", async () => {
    const result = await uninstallSkill("managed-skill");

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(refreshCallV2Enabled(0)).toBe(true);
  });

  test("successful update delegates to refresh helper with live config", async () => {
    const result = await updateSkill("some-skill");

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(refreshCallV2Enabled(0)).toBe(true);
  });

  test("failed update returns the error and does not refresh", async () => {
    mockClawhubUpdate.mockImplementation(async () => ({
      success: false,
      error: "update failed",
    }));

    const result = await updateSkill("some-skill");

    expect(result).toEqual({ success: false, error: "update failed" });
    expect(mockRefreshSkillCapabilityMemories).not.toHaveBeenCalled();
  });
});
