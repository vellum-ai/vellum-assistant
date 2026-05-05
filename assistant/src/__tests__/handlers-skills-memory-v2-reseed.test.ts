/**
 * Tests for the v2 skill re-seed sibling call wired into
 * `assistant/src/daemon/handlers/skills.ts`.
 *
 * One representative call site (the `installSkill` bundled branch) is
 * exercised — all handler seed sites share the same delegation to
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

const flagsState = { flagEnabled: true, configV2Enabled: true };

const mockRefreshSkillCapabilityMemories = mock(
  (_config: { memory: { v2: { enabled: boolean } } }) => {},
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
  API_KEY_PROVIDERS: [],
  applyNestedDefaults: (c: unknown) => c,
  deepMergeOverwrite: (a: unknown) => a,
  mergeDefaultWorkspaceConfig: () => {},
  getConfig: () => ({
    memory: { v2: { enabled: flagsState.configV2Enabled } },
  }),
  getConfigReadOnly: () => ({
    memory: { v2: { enabled: flagsState.configV2Enabled } },
  }),
  loadConfig: () => ({
    memory: { v2: { enabled: flagsState.configV2Enabled } },
  }),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  _appendQuarantineBulletin: () => {},
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
  assertInstalledSkillDiscoverable: () => {},
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
  seedSkillGraphNodes: () => {},
  seedUninstalledCatalogSkillMemories: async () => {},
}));

mock.module("../memory/v2/skill-store.js", () => ({
  seedV2SkillEntries: mock(async () => {}),
  getSkillCapability: () => null,
}));

mock.module("../daemon/skill-memory-refresh.js", () => ({
  refreshSkillCapabilityMemories: mockRefreshSkillCapabilityMemories,
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
const { installSkill } = await import("../daemon/handlers/skills.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2 skill re-seed gating in skill handlers", () => {
  beforeEach(() => {
    flagsState.flagEnabled = true;
    flagsState.configV2Enabled = true;
    mockRefreshSkillCapabilityMemories.mockClear();
  });

  test("flag + config both on → refresh helper invoked with live config", async () => {
    const result = await installSkill({ slug: "bundled-skill" });

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(mockRefreshSkillCapabilityMemories.mock.calls[0]?.[0]).toEqual({
      memory: { v2: { enabled: true } },
    });
  });

  test("flag off → handler still delegates to refresh helper", async () => {
    flagsState.flagEnabled = false;

    const result = await installSkill({ slug: "bundled-skill" });

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
  });

  test("config.memory.v2.enabled off → helper receives disabled config", async () => {
    flagsState.configV2Enabled = false;

    const result = await installSkill({ slug: "bundled-skill" });

    expect(result.success).toBe(true);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
    expect(mockRefreshSkillCapabilityMemories.mock.calls[0]?.[0]).toEqual({
      memory: { v2: { enabled: false } },
    });
  });

  // Note: "seed rejection swallowed" is now an internal concern of
  // `maybeSeedMemoryV2Skills` — it dispatches the seed call as a
  // fire-and-forget promise with `.catch(log.warn)`. That behavior is
  // covered by `lifecycle-memory-v2-seed.test.ts`. From the handler's
  // perspective, we only need to verify the helper is invoked
  // synchronously with the correct config — which the cases above already
  // exercise.
});
