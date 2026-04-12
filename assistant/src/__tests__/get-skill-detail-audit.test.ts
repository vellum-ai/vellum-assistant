import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const mockResolveSkillStates = mock(
  (): Array<{
    summary: {
      id: string;
      displayName: string;
      description: string;
      emoji?: string;
      source: "bundled" | "managed" | "workspace" | "extra" | "catalog";
      directoryPath: string;
    };
    state: "enabled" | "disabled";
  }> => [],
);

const mockReadInstallMeta = mock(
  (
    _dir: string,
  ): {
    origin: string;
    slug: string;
    sourceRepo?: string;
    installedAt?: string;
  } | null => null,
);

const mockResolveSkillSource = mock(
  (
    _source: string,
  ): { owner: string; repo: string; skillSlug: string; ref?: string } => ({
    owner: "acme",
    repo: "tools",
    skillSlug: "lint",
  }),
);

const mockFetchSkillAudits = mock(
  async (
    _source: string,
    _skillSlugs: string[],
  ): Promise<
    Record<
      string,
      Record<
        string,
        { risk: string; alerts?: number; score?: number; analyzedAt: string }
      >
    >
  > => ({}),
);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: mockResolveSkillStates,
  skillFlagKey: () => null,
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: mockReadInstallMeta,
}));

mock.module("../skills/skillssh-registry.js", () => ({
  searchSkillsRegistry: mock(async () => []),
  fetchSkillAudits: mockFetchSkillAudits,
  resolveSkillSource: mockResolveSkillSource,
  installExternalSkill: mock(async () => {}),
}));

mock.module("../skills/clawhub.js", () => ({
  clawhubSearch: mock(async () => ({ skills: [] })),
  clawhubCheckUpdates: mock(async () => []),
  clawhubInspect: mock(async () => ({})),
  clawhubInstall: mock(async () => ({ success: true })),
  clawhubUpdate: mock(async () => ({ success: true })),
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
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
  getCatalog: async () => [],
}));

mock.module("../skills/catalog-files.js", () => ({
  catalogSkillToSlim: () => ({}),
  createVellumCatalogProvider: () => ({
    canHandle: () => false,
    listFiles: async () => null,
    toSlimSkill: async () => null,
    readFileContent: async () => null,
  }),
  hasHiddenOrSkippedSegment: () => false,
  sanitizeRelativePath: (p: string) => p,
  SKIP_DIRS: new Set(),
}));

mock.module("../skills/skillssh-files.js", () => ({
  createSkillsShProvider: () => ({
    canHandle: () => false,
    listFiles: async () => null,
    toSlimSkill: async () => null,
    readFileContent: async () => null,
  }),
}));

mock.module("../skills/clawhub-files.js", () => ({
  createClawhubProvider: () => ({
    canHandle: () => false,
    listFiles: async () => null,
    toSlimSkill: async () => null,
    readFileContent: async () => null,
  }),
}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: async () => {},
  upsertSkillsIndex: () => {},
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

mock.module("../util/platform.js", () => ({
  getWorkspaceSkillsDir: () => "/tmp/test-skills",
}));

mock.module("../daemon/handlers/shared.js", () => ({
  CONFIG_RELOAD_DEBOUNCE_MS: 100,
  ensureSkillEntry: () => ({}),
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Import after mocking
import { getSkill } from "../daemon/handlers/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyCtx = {
  debounceTimers: { schedule: () => {} },
  setSuppressConfigReload: () => {},
  updateConfigFingerprint: () => {},
  broadcast: () => {},
} as unknown as Parameters<typeof getSkill>[1];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSkill — skillssh audit enrichment", () => {
  beforeEach(() => {
    mockResolveSkillStates.mockReset();
    mockReadInstallMeta.mockReset();
    mockResolveSkillSource.mockReset();
    mockFetchSkillAudits.mockReset();

    // Default: no skills resolved
    mockResolveSkillStates.mockReturnValue([]);
    mockReadInstallMeta.mockReturnValue(null);
    mockFetchSkillAudits.mockResolvedValue({});
  });

  test("enriches skillssh skill detail with audit data on success", async () => {
    // Set up a skillssh installed skill
    mockResolveSkillStates.mockReturnValue([
      {
        summary: {
          id: "acme/tools/lint",
          displayName: "Lint",
          description: "A lint skill",
          source: "extra" as const,
          directoryPath: "/tmp/test-skills/lint",
        },
        state: "enabled" as const,
      },
    ]);

    // Return skillssh origin from install-meta
    mockReadInstallMeta.mockReturnValue({
      origin: "skillssh",
      slug: "acme/tools/lint",
      sourceRepo: "acme/tools",
    });

    // resolveSkillSource parses the slug into owner/repo/skillSlug
    mockResolveSkillSource.mockReturnValue({
      owner: "acme",
      repo: "tools",
      skillSlug: "lint",
    });

    // fetchSkillAudits returns audit data keyed by skill slug
    mockFetchSkillAudits.mockResolvedValue({
      lint: {
        ath: { risk: "safe", score: 100, analyzedAt: "2025-06-01T00:00:00Z" },
        socket: {
          risk: "low",
          alerts: 1,
          analyzedAt: "2025-06-01T00:00:00Z",
        },
      },
    });

    const result = await getSkill("acme/tools/lint", dummyCtx);

    // Should succeed
    expect("skill" in result).toBe(true);
    if (!("skill" in result)) throw new Error("Expected skill response");

    const detail = result.skill;
    expect(detail.origin).toBe("skillssh");
    expect(detail.id).toBe("acme/tools/lint");
    expect(detail.name).toBe("Lint");

    // Verify audit data is attached
    if (detail.origin === "skillssh") {
      expect(detail.audit).toBeDefined();
      expect(detail.audit!.ath).toEqual({
        risk: "safe",
        score: 100,
        analyzedAt: "2025-06-01T00:00:00Z",
      });
      expect(detail.audit!.socket).toEqual({
        risk: "low",
        alerts: 1,
        analyzedAt: "2025-06-01T00:00:00Z",
      });
    }

    // Verify fetchSkillAudits was called correctly
    expect(mockFetchSkillAudits).toHaveBeenCalledTimes(1);
    expect(mockFetchSkillAudits).toHaveBeenCalledWith("acme/tools", ["lint"]);

    // Verify resolveSkillSource was called with the slug
    expect(mockResolveSkillSource).toHaveBeenCalledTimes(1);
    expect(mockResolveSkillSource).toHaveBeenCalledWith("acme/tools/lint");
  });

  test("returns detail without audit data when fetchSkillAudits throws", async () => {
    // Set up a skillssh installed skill
    mockResolveSkillStates.mockReturnValue([
      {
        summary: {
          id: "org/repo/my-tool",
          displayName: "My Tool",
          description: "A community tool",
          source: "extra" as const,
          directoryPath: "/tmp/test-skills/my-tool",
        },
        state: "enabled" as const,
      },
    ]);

    // Return skillssh origin from install-meta
    mockReadInstallMeta.mockReturnValue({
      origin: "skillssh",
      slug: "org/repo/my-tool",
      sourceRepo: "org/repo",
    });

    // resolveSkillSource parses the slug
    mockResolveSkillSource.mockReturnValue({
      owner: "org",
      repo: "repo",
      skillSlug: "my-tool",
    });

    // fetchSkillAudits throws an error
    mockFetchSkillAudits.mockRejectedValue(
      new Error("audit service unavailable"),
    );

    const result = await getSkill("org/repo/my-tool", dummyCtx);

    // Should still succeed — audit failure is non-fatal
    expect("skill" in result).toBe(true);
    if (!("skill" in result)) throw new Error("Expected skill response");

    const detail = result.skill;
    expect(detail.origin).toBe("skillssh");
    expect(detail.id).toBe("org/repo/my-tool");
    expect(detail.name).toBe("My Tool");

    // Audit data should not be present
    if (detail.origin === "skillssh") {
      expect(detail.audit).toBeUndefined();
    }

    // fetchSkillAudits was still called (just failed)
    expect(mockFetchSkillAudits).toHaveBeenCalledTimes(1);
  });
});
