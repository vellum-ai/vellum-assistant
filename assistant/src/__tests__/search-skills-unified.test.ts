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
  }> => [],
);
const mockClawhubSearch = mock(
  async (
    _query: string,
  ): Promise<{
    skills: Array<{
      name: string;
      slug: string;
      description: string;
      author: string;
      stars: number;
      installs: number;
      version: string;
      createdAt: number;
      source: string;
    }>;
  }> => ({ skills: [] }),
);
const mockSkillsshSearch = mock(
  async (
    _query: string,
    _limit?: number,
  ): Promise<
    Array<{
      id: string;
      skillId: string;
      name: string;
      installs: number;
      source: string;
    }>
  > => [],
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
  loadSkillCatalog: mockCatalogSkills,
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: (
    items: Array<{ id: string; displayName: string; description: string }>,
    query: string,
    _fields: unknown[],
  ) => {
    const lower = query.toLowerCase();
    return items.filter(
      (s) =>
        s.id.toLowerCase().includes(lower) ||
        s.displayName.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower),
    );
  },
}));

mock.module("../skills/clawhub.js", () => ({
  clawhubSearch: mockClawhubSearch,
  // Stubs for other exports that may be referenced at import time
  clawhubCheckUpdates: mock(async () => []),
  clawhubInspect: mock(async () => ({})),
  clawhubInstall: mock(async () => ({ success: true })),
  clawhubUpdate: mock(async () => ({ success: true })),
}));

mock.module("../skills/skillssh-registry.js", () => ({
  searchSkillsRegistry: mockSkillsshSearch,
  fetchSkillAudits: mockFetchSkillAudits,
}));

// Stub install-meta (needed by the new origin derivation logic)
mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
}));

// Stub remaining imports pulled in by skills.ts
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));
mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
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
  getCatalog: async () => [],
}));
mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: async () => {},
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
import { searchSkills } from "../daemon/handlers/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyCtx = {
  debounceTimers: { schedule: () => {} },
  setSuppressConfigReload: () => {},
  updateConfigFingerprint: () => {},
  broadcast: () => {},
} as unknown as Parameters<typeof searchSkills>[1];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchSkills (unified)", () => {
  beforeEach(() => {
    mockCatalogSkills.mockReset();
    mockClawhubSearch.mockReset();
    mockSkillsshSearch.mockReset();
    mockFetchSkillAudits.mockReset();

    // Defaults: empty results
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockResolvedValue({ skills: [] });
    mockSkillsshSearch.mockResolvedValue([]);
    mockFetchSkillAudits.mockResolvedValue({});
  });

  test("returns results from all three registries", async () => {
    mockCatalogSkills.mockReturnValue([
      {
        id: "weather",
        displayName: "Weather",
        description: "Weather lookup",
        source: "bundled",
      },
    ]);
    mockClawhubSearch.mockResolvedValue({
      skills: [
        {
          name: "Deploy",
          slug: "deploy",
          description: "Deploy helper",
          author: "alice",
          stars: 10,
          installs: 100,
          version: "1.0.0",
          createdAt: 1000,
          source: "clawhub",
        },
      ],
    });
    mockSkillsshSearch.mockResolvedValue([
      {
        id: "vercel-labs/skills/react-best",
        skillId: "react-best",
        name: "React Best Practices",
        installs: 500,
        source: "vercel-labs/skills",
      },
    ]);

    const result = await searchSkills("e", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    expect(result.skills).toHaveLength(3);

    // Verify ordering: catalog first, then clawhub, then skills.sh
    expect(result.skills[0]!.id).toBe("weather");
    expect(result.skills[0]!.origin).toBe("vellum");
    expect(result.skills[0]!.kind).toBe("catalog");
    expect(result.skills[0]!.status).toBe("available");
    expect(result.skills[1]!.id).toBe("deploy");
    expect(result.skills[1]!.origin).toBe("clawhub");
    expect(result.skills[1]!.kind).toBe("catalog");
    // Verify version is mapped through from clawhub search results
    const clawhubSkill = result.skills[1]!;
    if (clawhubSkill.origin === "clawhub") {
      expect(clawhubSkill.version).toBe("1.0.0");
    }
    expect(result.skills[2]!.id).toBe("vercel-labs/skills/react-best");
    expect(result.skills[2]!.origin).toBe("skillssh");
    expect(result.skills[2]!.kind).toBe("catalog");
  });

  test("deduplicates: catalog takes precedence over clawhub and skills.sh", async () => {
    mockCatalogSkills.mockReturnValue([
      {
        id: "shared-skill",
        displayName: "Shared Skill",
        description: "From catalog",
        source: "bundled",
      },
    ]);
    mockClawhubSearch.mockResolvedValue({
      skills: [
        {
          name: "Shared Skill",
          slug: "shared-skill",
          description: "From clawhub",
          author: "",
          stars: 5,
          installs: 50,
          version: "2.0.0",
          createdAt: 2000,
          source: "clawhub",
        },
      ],
    });
    // skills.sh uses full id as slug, so it won't collide with catalog/clawhub
    // short slugs. Dedup only removes the clawhub duplicate here.
    mockSkillsshSearch.mockResolvedValue([
      {
        id: "org/repo/shared-skill",
        skillId: "shared-skill",
        name: "Shared Skill",
        installs: 300,
        source: "org/repo",
      },
    ]);

    const result = await searchSkills("shared", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    // Catalog deduplicates clawhub (same slug "shared-skill"), but skills.sh
    // now uses the full id "org/repo/shared-skill" so it's a distinct entry.
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]!.id).toBe("shared-skill");
    expect(result.skills[0]!.origin).toBe("vellum");
    expect(result.skills[1]!.id).toBe("org/repo/shared-skill");
    expect(result.skills[1]!.origin).toBe("skillssh");
  });

  test("deduplicates: clawhub takes precedence over skills.sh with same slug", async () => {
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockResolvedValue({
      skills: [
        {
          name: "Overlap",
          slug: "overlap-skill",
          description: "From clawhub",
          author: "bob",
          stars: 20,
          installs: 200,
          version: "1.0.0",
          createdAt: 3000,
          source: "clawhub",
        },
      ],
    });
    // skills.sh now uses full id as slug, so it won't collide with clawhub
    // short slugs — both entries survive dedup.
    mockSkillsshSearch.mockResolvedValue([
      {
        id: "org/repo/overlap-skill",
        skillId: "overlap-skill",
        name: "Overlap",
        installs: 100,
        source: "org/repo",
      },
    ]);

    const result = await searchSkills("overlap", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    // Full id slug means no collision — both entries survive
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]!.id).toBe("overlap-skill");
    expect(result.skills[0]!.origin).toBe("clawhub");
    expect(result.skills[1]!.id).toBe("org/repo/overlap-skill");
    expect(result.skills[1]!.origin).toBe("skillssh");
  });

  test("returns clawhub results when skills.sh fails", async () => {
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockResolvedValue({
      skills: [
        {
          name: "ClawhubSkill",
          slug: "clawhub-only",
          description: "",
          author: "",
          stars: 0,
          installs: 0,
          version: "",
          createdAt: 0,
          source: "clawhub",
        },
      ],
    });
    mockSkillsshSearch.mockRejectedValue(new Error("skills.sh is down"));

    const result = await searchSkills("clawhub", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.id).toBe("clawhub-only");
    expect(result.skills[0]!.origin).toBe("clawhub");
  });

  test("returns skills.sh results when clawhub fails", async () => {
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockRejectedValue(new Error("clawhub is down"));
    mockSkillsshSearch.mockResolvedValue([
      {
        id: "org/repo/skillssh-only",
        skillId: "skillssh-only",
        name: "SkillsShOnly",
        installs: 42,
        source: "org/repo",
      },
    ]);

    const result = await searchSkills("skillssh", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.id).toBe("org/repo/skillssh-only");
    expect(result.skills[0]!.origin).toBe("skillssh");
  });

  test("returns catalog-only results when both community registries fail", async () => {
    mockCatalogSkills.mockReturnValue([
      {
        id: "my-skill",
        displayName: "My Skill",
        description: "A bundled skill",
        source: "bundled",
      },
    ]);
    mockClawhubSearch.mockRejectedValue(new Error("clawhub down"));
    mockSkillsshSearch.mockRejectedValue(new Error("skillssh down"));

    const result = await searchSkills("my", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.id).toBe("my-skill");
    expect(result.skills[0]!.origin).toBe("vellum");
  });

  test("skills.sh results have correct normalized fields", async () => {
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockResolvedValue({ skills: [] });
    mockSkillsshSearch.mockResolvedValue([
      {
        id: "org/repo/test-skill",
        skillId: "test-skill",
        name: "Test Skill",
        installs: 99,
        source: "org/repo",
      },
    ]);

    const result = await searchSkills("test", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    expect(result.skills).toHaveLength(1);

    const skill = result.skills[0]!;
    expect(skill.id).toBe("org/repo/test-skill");
    expect(skill.name).toBe("Test Skill");
    expect(skill.description).toBe("");
    expect(skill.kind).toBe("catalog");
    expect(skill.origin).toBe("skillssh");
    expect(skill.status).toBe("available");
    if (skill.origin === "skillssh") {
      expect(skill.slug).toBe("org/repo/test-skill");
      expect(skill.sourceRepo).toBe("org/repo");
      expect(skill.installs).toBe(99);
    }
  });

  test("attaches audit data to skills.sh results on success", async () => {
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockResolvedValue({ skills: [] });
    mockSkillsshSearch.mockResolvedValue([
      {
        id: "acme/tools/lint",
        skillId: "lint",
        name: "Lint",
        installs: 10,
        source: "acme/tools",
      },
      {
        id: "acme/tools/format",
        skillId: "format",
        name: "Format",
        installs: 20,
        source: "acme/tools",
      },
    ]);
    mockFetchSkillAudits.mockResolvedValue({
      lint: {
        ath: { risk: "safe", score: 100, analyzedAt: "2025-01-01T00:00:00Z" },
      },
      format: {
        socket: {
          risk: "low",
          alerts: 2,
          analyzedAt: "2025-01-02T00:00:00Z",
        },
      },
    });

    const result = await searchSkills("lint", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    expect(result.skills).toHaveLength(2);

    const lintSkill = result.skills.find((s) => s.id === "acme/tools/lint")!;
    expect(lintSkill.origin).toBe("skillssh");
    if (lintSkill.origin === "skillssh") {
      expect(lintSkill.audit).toBeDefined();
      expect(lintSkill.audit!.ath).toEqual({
        risk: "safe",
        score: 100,
        analyzedAt: "2025-01-01T00:00:00Z",
      });
    }

    const formatSkill = result.skills.find(
      (s) => s.id === "acme/tools/format",
    )!;
    expect(formatSkill.origin).toBe("skillssh");
    if (formatSkill.origin === "skillssh") {
      expect(formatSkill.audit).toBeDefined();
      expect(formatSkill.audit!.socket).toEqual({
        risk: "low",
        alerts: 2,
        analyzedAt: "2025-01-02T00:00:00Z",
      });
    }

    // Verify fetchSkillAudits was called with grouped source/slugs
    expect(mockFetchSkillAudits).toHaveBeenCalledTimes(1);
    expect(mockFetchSkillAudits).toHaveBeenCalledWith("acme/tools", [
      "lint",
      "format",
    ]);
  });

  test("search succeeds when fetchSkillAudits throws", async () => {
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockResolvedValue({ skills: [] });
    mockSkillsshSearch.mockResolvedValue([
      {
        id: "org/repo/my-skill",
        skillId: "my-skill",
        name: "My Skill",
        installs: 5,
        source: "org/repo",
      },
    ]);
    mockFetchSkillAudits.mockRejectedValue(new Error("audit service down"));

    const result = await searchSkills("my-skill", dummyCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected success");

    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.origin).toBe("skillssh");
    if (skill.origin === "skillssh") {
      expect(skill.audit).toBeUndefined();
    }
  });
});
