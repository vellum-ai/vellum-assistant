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
mock.module("../skills/skill-memory.js", () => ({
  deleteSkillCapabilityMemory: () => {},
  seedCatalogSkillMemories: () => {},
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

    // Defaults: empty results
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubSearch.mockResolvedValue({ skills: [] });
    mockSkillsshSearch.mockResolvedValue([]);
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

    const data = result.data as {
      skills: Array<{ slug: string; source: string; origin: string }>;
    };
    expect(data.skills).toHaveLength(3);

    // Verify ordering: catalog first, then clawhub, then skills.sh
    expect(data.skills[0]!.slug).toBe("weather");
    expect(data.skills[0]!.source).toBe("vellum");
    expect(data.skills[0]!.origin).toBe("vellum");
    expect(data.skills[1]!.slug).toBe("deploy");
    expect(data.skills[1]!.source).toBe("clawhub");
    expect(data.skills[1]!.origin).toBe("clawhub");
    expect(data.skills[2]!.slug).toBe("vercel-labs/skills/react-best");
    expect(data.skills[2]!.source).toBe("skillssh");
    expect(data.skills[2]!.origin).toBe("skillssh");
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

    const data = result.data as {
      skills: Array<{ slug: string; source: string; origin: string }>;
    };
    // Catalog deduplicates clawhub (same slug "shared-skill"), but skills.sh
    // now uses the full id "org/repo/shared-skill" so it's a distinct entry.
    expect(data.skills).toHaveLength(2);
    expect(data.skills[0]!.slug).toBe("shared-skill");
    expect(data.skills[0]!.source).toBe("vellum");
    expect(data.skills[0]!.origin).toBe("vellum");
    expect(data.skills[1]!.slug).toBe("org/repo/shared-skill");
    expect(data.skills[1]!.source).toBe("skillssh");
    expect(data.skills[1]!.origin).toBe("skillssh");
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

    const data = result.data as {
      skills: Array<{ slug: string; source: string; origin: string }>;
    };
    // Full id slug means no collision — both entries survive
    expect(data.skills).toHaveLength(2);
    expect(data.skills[0]!.slug).toBe("overlap-skill");
    expect(data.skills[0]!.source).toBe("clawhub");
    expect(data.skills[0]!.origin).toBe("clawhub");
    expect(data.skills[1]!.slug).toBe("org/repo/overlap-skill");
    expect(data.skills[1]!.source).toBe("skillssh");
    expect(data.skills[1]!.origin).toBe("skillssh");
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

    const data = result.data as {
      skills: Array<{ slug: string; source: string; origin: string }>;
    };
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0]!.slug).toBe("clawhub-only");
    expect(data.skills[0]!.source).toBe("clawhub");
    expect(data.skills[0]!.origin).toBe("clawhub");
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

    const data = result.data as {
      skills: Array<{ slug: string; source: string; origin: string }>;
    };
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0]!.slug).toBe("org/repo/skillssh-only");
    expect(data.skills[0]!.source).toBe("skillssh");
    expect(data.skills[0]!.origin).toBe("skillssh");
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

    const data = result.data as {
      skills: Array<{ slug: string; source: string; origin: string }>;
    };
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0]!.slug).toBe("my-skill");
    expect(data.skills[0]!.source).toBe("vellum");
    expect(data.skills[0]!.origin).toBe("vellum");
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

    const data = result.data as {
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
        origin: string;
      }>;
    };
    expect(data.skills).toHaveLength(1);

    const skill = data.skills[0]!;
    expect(skill.name).toBe("Test Skill");
    expect(skill.slug).toBe("org/repo/test-skill");
    expect(skill.description).toBe("");
    expect(skill.author).toBe("");
    expect(skill.stars).toBe(0);
    expect(skill.installs).toBe(99);
    expect(skill.version).toBe("");
    expect(skill.createdAt).toBe(0);
    expect(skill.source).toBe("skillssh");
    expect(skill.origin).toBe("skillssh");
  });
});
