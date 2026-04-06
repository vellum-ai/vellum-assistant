import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock state ──────────────────────────────────────────────────────────────

const mockLoadSkillCatalog = mock(() => [] as Array<Record<string, unknown>>);
const mockResolveSkillStates = mock(
  () => [] as Array<{ summary: Record<string, unknown>; state: string }>,
);
const mockSaveRawConfig = mock();
const mockLoadRawConfig = mock(() => ({}));
const mockEnsureSkillEntry = mock(
  (_raw: Record<string, unknown>, _id: string) =>
    ({}) as Record<string, unknown>,
);
const mockSeedSkillGraphNodes = mock(() => {});
const mockSeedUninstalledCatalogSkillMemories = mock(async () => {});
const mockBroadcastCalls: Array<{ type: string; [k: string]: unknown }> = [];

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: mockLoadSkillCatalog,
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: mockResolveSkillStates,
  skillFlagKey: () => null,
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
  loadRawConfig: mockLoadRawConfig,
  saveRawConfig: mockSaveRawConfig,
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
}));

mock.module("../skills/clawhub.js", () => ({
  clawhubCheckUpdates: mock(async () => []),
  clawhubInspect: mock(async () => ({})),
  clawhubInstall: mock(async () => ({ success: true })),
  clawhubSearch: mock(async () => ({ skills: [] })),
  clawhubUpdate: mock(async () => ({ success: true })),
}));

mock.module("../skills/skillssh-registry.js", () => ({
  installExternalSkill: mock(async () => {}),
  resolveSkillSource: () => ({ owner: "a", repo: "b", skillSlug: "c" }),
  searchSkillsRegistry: mock(async () => []),
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
  getCatalog: mock(async () => []),
}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: mock(async () => {}),
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
  seedUninstalledCatalogSkillMemories: mockSeedUninstalledCatalogSkillMemories,
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

// ── Imports (after mocks) ───────────────────────────────────────────────────

import type { SkillOperationContext } from "../daemon/handlers/skills.js";
import {
  configureSkill,
  disableSkill,
  enableSkill,
  getSkill,
  getSkillFiles,
  listSkills,
} from "../daemon/handlers/skills.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createSkillCtx(): SkillOperationContext {
  mockBroadcastCalls.length = 0;
  return {
    debounceTimers: {
      schedule: () => {},
    } as unknown as SkillOperationContext["debounceTimers"],
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    broadcast: (msg) => {
      mockBroadcastCalls.push(msg as { type: string; [k: string]: unknown });
    },
  };
}

function makeSummary(
  id: string,
  source: string,
  overrides?: Record<string, unknown>,
) {
  return {
    id,
    name: id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    description: `${id} skill`,
    directoryPath: `/tmp/test-skills/${id}`,
    skillFilePath: `/tmp/test-skills/${id}/SKILL.md`,
    source,
    emoji: undefined,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("listSkills", () => {
  beforeEach(() => {
    mockLoadSkillCatalog.mockReset();
    mockResolveSkillStates.mockReset();
  });

  test("returns empty array when catalog is empty", () => {
    mockLoadSkillCatalog.mockReturnValue([]);
    mockResolveSkillStates.mockReturnValue([]);

    const result = listSkills(createSkillCtx());

    expect(result).toEqual([]);
  });

  test("sorts by kind rank (bundled first) then alphabetical", () => {
    mockResolveSkillStates.mockReturnValue([
      { summary: makeSummary("zebra", "managed"), state: "enabled" },
      { summary: makeSummary("browser", "bundled"), state: "enabled" },
      { summary: makeSummary("alpha", "managed"), state: "disabled" },
    ]);

    const result = listSkills(createSkillCtx());

    // bundled (browser) first, then installed sorted alpha
    expect(result[0].id).toBe("browser");
    expect(result[1].id).toBe("alpha");
    expect(result[2].id).toBe("zebra");
  });

  test("maps source to correct kind and origin", () => {
    mockResolveSkillStates.mockReturnValue([
      { summary: makeSummary("bundled-skill", "bundled"), state: "enabled" },
      { summary: makeSummary("managed-skill", "managed"), state: "disabled" },
    ]);

    const result = listSkills(createSkillCtx());

    const bundled = result.find((s) => s.id === "bundled-skill")!;
    expect(bundled.kind).toBe("bundled");
    expect(bundled.origin).toBe("vellum");
    expect(bundled.status).toBe("enabled");

    const managed = result.find((s) => s.id === "managed-skill")!;
    expect(managed.kind).toBe("installed");
    expect(managed.origin).toBe("custom");
    expect(managed.status).toBe("disabled");
  });
});

describe("enableSkill", () => {
  beforeEach(() => {
    mockLoadRawConfig.mockReset();
    mockSaveRawConfig.mockReset();
    mockEnsureSkillEntry.mockReset();
    mockSeedSkillGraphNodes.mockReset();
    mockLoadRawConfig.mockReturnValue({});
    mockEnsureSkillEntry.mockReturnValue({});
  });

  test("enables skill, broadcasts, and seeds memory", () => {
    const ctx = createSkillCtx();

    const result = enableSkill("weather", ctx);

    expect(result).toEqual({ success: true });
    expect(mockEnsureSkillEntry).toHaveBeenCalledWith(
      expect.any(Object),
      "weather",
    );
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
    expect(mockBroadcastCalls).toHaveLength(1);
    expect(mockBroadcastCalls[0].type).toBe("skills_state_changed");
    expect(mockBroadcastCalls[0].name).toBe("weather");
    expect(mockBroadcastCalls[0].state).toBe("enabled");
    expect(mockSeedSkillGraphNodes).toHaveBeenCalledTimes(1);
  });

  test("returns error on config save failure", () => {
    mockSaveRawConfig.mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = enableSkill("weather", createSkillCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("disk full");
    }
  });
});

describe("disableSkill", () => {
  beforeEach(() => {
    mockLoadRawConfig.mockReset();
    mockSaveRawConfig.mockReset();
    mockEnsureSkillEntry.mockReset();
    mockSeedSkillGraphNodes.mockReset();
    mockLoadRawConfig.mockReturnValue({});
    mockEnsureSkillEntry.mockReturnValue({});
  });

  test("disables skill and broadcasts", () => {
    const ctx = createSkillCtx();

    const result = disableSkill("weather", ctx);

    expect(result).toEqual({ success: true });
    expect(mockBroadcastCalls).toHaveLength(1);
    expect(mockBroadcastCalls[0].state).toBe("disabled");
  });

  test("returns error on config save failure", () => {
    mockSaveRawConfig.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const result = disableSkill("weather", createSkillCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("permission denied");
    }
  });
});

describe("configureSkill", () => {
  beforeEach(() => {
    mockLoadRawConfig.mockReset();
    mockSaveRawConfig.mockReset();
    mockEnsureSkillEntry.mockReset();
    mockLoadRawConfig.mockReturnValue({});
  });

  test("sets env on skill entry", () => {
    const entry: Record<string, unknown> = {};
    mockEnsureSkillEntry.mockReturnValue(entry);

    const result = configureSkill(
      "weather",
      { env: { API_KEY: "abc" } },
      createSkillCtx(),
    );

    expect(result).toEqual({ success: true });
    expect(entry.env).toEqual({ API_KEY: "abc" });
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
  });

  test("sets apiKey on skill entry", () => {
    const entry: Record<string, unknown> = {};
    mockEnsureSkillEntry.mockReturnValue(entry);

    configureSkill("weather", { apiKey: "sk-test" }, createSkillCtx());

    expect(entry.apiKey).toBe("sk-test");
  });

  test("sets config on skill entry", () => {
    const entry: Record<string, unknown> = {};
    mockEnsureSkillEntry.mockReturnValue(entry);

    configureSkill(
      "weather",
      { config: { units: "celsius" } },
      createSkillCtx(),
    );

    expect(entry.config).toEqual({ units: "celsius" });
  });
});

describe("getSkill", () => {
  beforeEach(() => {
    mockLoadSkillCatalog.mockReset();
    mockResolveSkillStates.mockReset();
  });

  test("returns skill detail for existing skill", async () => {
    mockResolveSkillStates.mockReturnValue([
      {
        summary: makeSummary("weather", "bundled"),
        state: "enabled",
      },
    ]);

    const result = await getSkill("weather", createSkillCtx());

    expect("skill" in result).toBe(true);
    if ("skill" in result) {
      expect(result.skill.id).toBe("weather");
      expect(result.skill.origin).toBe("vellum");
    }
  });

  test("returns 404 for non-existent skill", async () => {
    mockResolveSkillStates.mockReturnValue([]);

    const result = await getSkill("nonexistent", createSkillCtx());

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(404);
      expect(result.error).toContain("nonexistent");
    }
  });
});

describe("getSkillFiles", () => {
  beforeEach(() => {
    mockLoadSkillCatalog.mockReset();
    mockResolveSkillStates.mockReset();
  });

  test("returns file listing for existing skill with directory", () => {
    // Use the real test workspace dir which exists
    const testDir = process.env.VELLUM_WORKSPACE_DIR!;
    mockResolveSkillStates.mockReturnValue([
      {
        summary: makeSummary("weather", "managed", {
          directoryPath: testDir,
        }),
        state: "enabled",
      },
    ]);

    const result = getSkillFiles("weather", createSkillCtx());

    expect("files" in result).toBe(true);
    if ("files" in result) {
      expect(result.skill.id).toBe("weather");
      expect(Array.isArray(result.files)).toBe(true);
    }
  });

  test("returns 404 for non-existent skill", () => {
    mockResolveSkillStates.mockReturnValue([]);

    const result = getSkillFiles("nonexistent", createSkillCtx());

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(404);
    }
  });
});
