import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const mockCatalogSkills = mock(
  (): Array<{
    id: string;
    displayName: string;
    description: string;
    source: string;
    directoryPath?: string;
  }> => [],
);
const mockClawhubInstall = mock(
  async (
    _slug: string,
    _opts?: { version?: string },
  ): Promise<{ success: boolean; error?: string; skillName?: string }> => ({
    success: true,
  }),
);
const mockInstallExternalSkill = mock(
  async (
    _owner: string,
    _repo: string,
    _skillSlug: string,
    _overwrite: boolean,
    _ref?: string,
  ): Promise<void> => {},
);
const mockGetCatalog = mock(async () => []);
const mockInstallSkillLocally = mock(async () => {});
const mockSeedSkillGraphNodes = mock(() => {});
const mockEnsureSkillEntry = mock(
  (_raw: Record<string, unknown>, _id: string) => ({
    enabled: false,
  }),
);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: mockCatalogSkills,
}));

mock.module("../skills/clawhub.js", () => ({
  clawhubCheckUpdates: mock(async () => []),
  clawhubInspect: mock(async () => ({})),
  clawhubInstall: mockClawhubInstall,
  clawhubSearch: mock(async () => ({ skills: [] })),
  clawhubUpdate: mock(async () => ({ success: true })),
}));

mock.module("../skills/skillssh-registry.js", () => ({
  installExternalSkill: mockInstallExternalSkill,
  resolveSkillSource: (source: string) => {
    const parts = source.split("/");
    if (parts.length >= 3) {
      return {
        owner: parts[0]!,
        repo: parts[1]!,
        skillSlug: parts.slice(2).join("/"),
      };
    }
    throw new Error(`Invalid skill source "${source}"`);
  },
  searchSkillsRegistry: mock(async () => []),
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
}));
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ memory: { v2: { enabled: false } } }),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));
mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => [],
  skillFlagKey: () => null,
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
}));
mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: mockGetCatalog,
}));
mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: mockInstallSkillLocally,
  upsertSkillsIndex: () => {},
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
mock.module("../util/platform.js", () => ({
  getWorkspaceSkillsDir: () => "/tmp/test-skills",
}));
mock.module("../daemon/handlers/shared.js", () => ({
  CONFIG_RELOAD_DEBOUNCE_MS: 100,
  ensureSkillEntry: mockEnsureSkillEntry,
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Import after mocking
import { installSkill } from "../daemon/handlers/skills.js";

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

describe("installSkill routing", () => {
  beforeEach(() => {
    mockCatalogSkills.mockReset();
    mockClawhubInstall.mockReset();
    mockInstallExternalSkill.mockReset();
    mockGetCatalog.mockReset();
    mockInstallSkillLocally.mockReset();
    mockSeedSkillGraphNodes.mockReset();
    mockEnsureSkillEntry.mockReset();

    // Defaults
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubInstall.mockResolvedValue({ success: true });
    mockInstallExternalSkill.mockResolvedValue(undefined);
    mockGetCatalog.mockResolvedValue([]);
    mockInstallSkillLocally.mockResolvedValue(undefined);
    mockSeedSkillGraphNodes.mockReturnValue(undefined);
    mockEnsureSkillEntry.mockReturnValue({ enabled: false });
  });

  test("install with origin: 'skillssh' and multi-segment slug routes to installExternalSkill", async () => {
    const result = await installSkill(
      {
        slug: "vercel-labs/agent-skills/react-best-practices",
        origin: "skillssh",
      },
      dummyCtx,
    );

    expect(result.success).toBe(true);
    expect(mockInstallExternalSkill).toHaveBeenCalledTimes(1);
    expect(mockInstallExternalSkill).toHaveBeenCalledWith(
      "vercel-labs",
      "agent-skills",
      "react-best-practices",
      true, // overwrite
      undefined, // ref
      undefined, // contactId
    );
    // Should not have called clawhub
    expect(mockClawhubInstall).not.toHaveBeenCalled();
  });

  test("install without origin falls through to clawhub for simple slugs", async () => {
    const result = await installSkill({ slug: "some-clawhub-skill" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(mockClawhubInstall).toHaveBeenCalledTimes(1);
    expect(mockClawhubInstall).toHaveBeenCalledWith("some-clawhub-skill", {
      version: undefined,
    });
    // Should not have called installExternalSkill
    expect(mockInstallExternalSkill).not.toHaveBeenCalled();
  });

  test("install with origin: 'clawhub' routes directly to clawhub without trying skills.sh", async () => {
    const result = await installSkill(
      { slug: "my-skill", origin: "clawhub" },
      dummyCtx,
    );

    expect(result.success).toBe(true);
    expect(mockClawhubInstall).toHaveBeenCalledTimes(1);
    expect(mockInstallExternalSkill).not.toHaveBeenCalled();
  });

  test("multi-segment slug without explicit origin auto-routes to skills.sh", async () => {
    const result = await installSkill(
      { slug: "owner/repo/my-skill" },
      dummyCtx,
    );

    expect(result.success).toBe(true);
    expect(mockInstallExternalSkill).toHaveBeenCalledTimes(1);
    expect(mockInstallExternalSkill).toHaveBeenCalledWith(
      "owner",
      "repo",
      "my-skill",
      true,
      undefined, // ref
      undefined, // contactId
    );
    expect(mockClawhubInstall).not.toHaveBeenCalled();
  });

  test("multi-segment slug with origin: 'clawhub' skips skills.sh and routes to clawhub", async () => {
    // Even though the slug looks like skills.sh format, explicit origin: "clawhub"
    // should override the auto-detection and go to clawhub
    const result = await installSkill(
      { slug: "owner/repo/my-skill", origin: "clawhub" },
      dummyCtx,
    );

    expect(result.success).toBe(true);
    expect(mockClawhubInstall).toHaveBeenCalledTimes(1);
    expect(mockInstallExternalSkill).not.toHaveBeenCalled();
  });

  test("bundled skills are auto-enabled regardless of origin", async () => {
    mockCatalogSkills.mockReturnValue([
      {
        id: "bundled-skill",
        displayName: "Bundled Skill",
        description: "A bundled skill",
        source: "bundled",
        directoryPath: "/tmp/test-bundled-skills/bundled-skill",
      },
    ]);

    const result = await installSkill(
      { slug: "bundled-skill", origin: "skillssh" },
      dummyCtx,
    );

    expect(result.success).toBe(true);
    // Should have auto-enabled via ensureSkillEntry, not called external install
    expect(mockInstallExternalSkill).not.toHaveBeenCalled();
    expect(mockClawhubInstall).not.toHaveBeenCalled();
  });

  test("skills.sh install failure propagates error", async () => {
    mockInstallExternalSkill.mockRejectedValue(
      new Error("Skill not found in repo"),
    );

    const result = await installSkill(
      {
        slug: "owner/repo/nonexistent-skill",
        origin: "skillssh",
      },
      dummyCtx,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Skill not found in repo");
    }
  });
});
