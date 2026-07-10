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

const configState = { v2Enabled: true };

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

// Stub both `getConfig` and `loadConfig`. `loadConfig` is reached by code
// paths transitively imported during teardown (e.g. dynamic imports inside
// `oauth2.ts`); leaving it undefined here would break sibling test files
// run in the same Bun process because `mock.module` replacements persist
// across files.
mock.module("../config/loader.js", () => ({
  API_KEY_PROVIDERS: [],
  applyNestedDefaults: (c: unknown) => c,
  deepMergeOverwrite: (a: unknown) => a,
  mergeDefaultWorkspaceConfig: () => {},
  getConfig: () => ({
    memory: { v2: { enabled: configState.v2Enabled } },
  }),
  getConfigReadOnly: () => ({
    memory: { v2: { enabled: configState.v2Enabled } },
  }),
  loadConfig: () => ({
    memory: { v2: { enabled: configState.v2Enabled } },
  }),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  _writeQuarantineNotice: () => {},
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

mock.module("../util/platform.js", () => {
  const stub = () => "/tmp/test-stub";
  return {
    getWorkspaceSkillsDir: () => "/tmp/test-skills",
    vellumRoot: stub,
    isMacOS: () => false,
    isLinux: () => true,
    isWindows: () => false,
    getPlatformName: () => "linux",
    normalizeAssistantId: (id: string) => id,
    getDataDir: stub,
    getEmbeddingModelsDir: stub,
    getSandboxRootDir: stub,
    getSandboxWorkingDir: stub,
    getSoundsDir: stub,
    getAvatarDir: stub,
    AVATAR_IMAGE_FILENAME: "avatar-image.png",
    getAvatarImagePath: stub,
    getXdgVellumConfigDirName: () => ".vellum",
    getPidPath: stub,
    getDbPath: stub,
    getLogsDir: stub,
    getHistoryPath: stub,
    getProtectedDir: stub,
    getSignalsDir: stub,
    getDaemonStderrLogPath: stub,
    getDaemonStartupLockPath: stub,
    getExternalDir: stub,
    getBinDir: stub,
    getDotEnvPath: stub,
    getEmbedWorkerPidPath: stub,
    getWorkspaceDir: stub,
    getWorkspaceDirDisplay: stub,
    getWorkspaceConfigPath: stub,
    getWorkspaceHooksDir: stub,
    getWorkspacePluginsDir: stub,
    getWorkspaceRoutesDir: stub,
    getDeprecatedDir: stub,
    getConversationsDir: stub,
    getWorkspacePromptPath: stub,
    getProfilerRootDir: stub,
    getProfilerRunsDir: stub,
    getProfilerRunDir: stub,
    ensureDataDir: () => {},
  };
});

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2 skill refresh delegation in skill handlers", () => {
  beforeEach(() => {
    configState.v2Enabled = true;
    mockRefreshSkillCapabilityMemories.mockClear();
    mockClawhubUpdate.mockReset();
    mockClawhubUpdate.mockImplementation(async () => ({ success: true }));
  });

  test("enabled config → refresh helper invoked with live config", async () => {
    const result = await installSkill({ slug: "bundled-skill" });

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(mockRefreshSkillCapabilityMemories.mock.calls[0]?.[0]).toEqual({
      memory: { v2: { enabled: true } },
    });
  });

  test("config.memory.v2.enabled off → helper receives disabled config", async () => {
    configState.v2Enabled = false;

    const result = await installSkill({ slug: "bundled-skill" });

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(mockRefreshSkillCapabilityMemories.mock.calls[0]?.[0]).toEqual({
      memory: { v2: { enabled: false } },
    });
  });

  test("uninstall delegates to refresh helper", async () => {
    const result = await uninstallSkill("managed-skill");

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(mockRefreshSkillCapabilityMemories.mock.calls[0]?.[0]).toEqual({
      memory: { v2: { enabled: true } },
    });
  });

  test("successful update delegates to refresh helper with live config", async () => {
    const result = await updateSkill("some-skill");

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(mockRefreshSkillCapabilityMemories.mock.calls[0]?.[0]).toEqual({
      memory: { v2: { enabled: true } },
    });
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
