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
const mockDeleteManagedSkill = mock(
  () => ({ deleted: true }) as { deleted: boolean; error?: string },
);
const mockCreateManagedSkill = mock(
  () => ({ created: true }) as { created: boolean; error?: string },
);
const mockValidateManagedSkillId = mock(() => null as string | null);
const mockRemoveSkillsIndexEntry = mock();
const mockDeleteSkillCapabilityNode = mock();
const mockClawhubUpdate = mock(
  async () => ({ success: true }) as { success: boolean; error?: string },
);
const mockClawhubCheckUpdates = mock(async () => []);
const mockClawhubInspect = mock(
  async () => ({}) as { data?: unknown; error?: string },
);
const mockGetCatalog = mock(async () => [] as Array<Record<string, unknown>>);
const mockGetConfiguredProvider = mock(async () => null as unknown);
const mockExtractText = mock(() => "");
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
  clawhubCheckUpdates: mockClawhubCheckUpdates,
  clawhubInspect: mockClawhubInspect,
  clawhubInstall: mock(async () => ({ success: true })),
  clawhubSearch: mock(async () => ({ skills: [] })),
  clawhubUpdate: mockClawhubUpdate,
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
  extractText: mockExtractText,
  getConfiguredProvider: mockGetConfiguredProvider,
  userMessage: (text: string) => ({ role: "user", content: text }),
}));

mock.module("../runtime/routes/workspace-utils.js", () => ({
  isTextMimeType: () => true,
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: mockGetCatalog,
}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: mock(async () => {}),
  upsertSkillsIndex: () => {},
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
}));

mock.module("../skills/managed-store.js", () => ({
  createManagedSkill: mockCreateManagedSkill,
  deleteManagedSkill: mockDeleteManagedSkill,
  removeSkillsIndexEntry: mockRemoveSkillsIndexEntry,
  validateManagedSkillId: mockValidateManagedSkillId,
}));

mock.module("../memory/graph/capability-seed.js", () => ({
  deleteSkillCapabilityNode: mockDeleteSkillCapabilityNode,
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
  checkSkillUpdates,
  createSkill,
  draftSkill,
  inspectSkill,
  listSkillsWithCatalog,
  postInstallSkill,
  uninstallSkill,
  updateSkill,
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

describe("uninstallSkill", () => {
  beforeEach(() => {
    mockDeleteManagedSkill.mockReset();
    mockDeleteManagedSkill.mockReturnValue({ deleted: true });
    mockValidateManagedSkillId.mockReset();
    mockValidateManagedSkillId.mockReturnValue(null);
    mockLoadRawConfig.mockReset();
    mockLoadRawConfig.mockReturnValue({});
    mockSaveRawConfig.mockReset();
    mockRemoveSkillsIndexEntry.mockReset();
    mockDeleteSkillCapabilityNode.mockReset();
  });

  test("managed skill: calls deleteManagedSkill, cleans config, broadcasts", async () => {
    // validateManagedSkillId returns null → valid managed ID → isManagedId = true
    mockLoadRawConfig.mockReturnValue({
      skills: { entries: { weather: { enabled: true } } },
    });

    const result = await uninstallSkill("weather", createSkillCtx());

    expect(result).toEqual({ success: true });
    expect(mockDeleteManagedSkill).toHaveBeenCalledWith("weather");
    expect(mockBroadcastCalls).toHaveLength(1);
    expect(mockBroadcastCalls[0].type).toBe("skills_state_changed");
    expect(mockBroadcastCalls[0].state).toBe("uninstalled");
  });

  test("path traversal attempt rejected", async () => {
    const result = await uninstallSkill("../../etc/passwd", createSkillCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Invalid skill name");
    }
    expect(mockDeleteManagedSkill).not.toHaveBeenCalled();
  });

  test("backslash in name rejected", async () => {
    const result = await uninstallSkill("foo\\bar", createSkillCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Invalid skill name");
    }
  });

  test("managed deletion failure returns error", async () => {
    mockDeleteManagedSkill.mockReturnValue({
      deleted: false,
      error: "Skill not found",
    });

    const result = await uninstallSkill("nonexistent", createSkillCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Skill not found");
    }
  });

  test("config entry cleaned up after deletion", async () => {
    const configWithEntry = {
      skills: { entries: { myskill: { enabled: true, env: {} } } },
    };
    mockLoadRawConfig.mockReturnValue(configWithEntry);

    await uninstallSkill("myskill", createSkillCtx());

    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
  });
});

describe("updateSkill", () => {
  beforeEach(() => {
    mockClawhubUpdate.mockReset();
    mockLoadSkillCatalog.mockReset();
  });

  test("success delegates to clawhubUpdate and reloads catalog", async () => {
    mockClawhubUpdate.mockResolvedValue({ success: true });

    const result = await updateSkill("my-skill", createSkillCtx());

    expect(result).toEqual({ success: true });
    expect(mockClawhubUpdate).toHaveBeenCalledWith("my-skill");
    expect(mockLoadSkillCatalog).toHaveBeenCalledTimes(1);
  });

  test("failure returns error", async () => {
    mockClawhubUpdate.mockResolvedValue({
      success: false,
      error: "Version conflict",
    });

    const result = await updateSkill("my-skill", createSkillCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Version conflict");
    }
  });
});

describe("checkSkillUpdates", () => {
  beforeEach(() => {
    mockClawhubCheckUpdates.mockReset();
  });

  test("delegates to clawhubCheckUpdates", async () => {
    const updates = [{ skillId: "s1", available: "1.1.0" }];
    mockClawhubCheckUpdates.mockResolvedValue(updates as any);

    const result = await checkSkillUpdates(createSkillCtx());

    expect(result).toEqual({ success: true, data: updates });
  });
});

describe("inspectSkill", () => {
  beforeEach(() => {
    mockClawhubInspect.mockReset();
  });

  test("delegates to clawhubInspect", async () => {
    mockClawhubInspect.mockResolvedValue({
      data: { name: "My Skill", version: "1.0.0" },
    });

    const result = await inspectSkill("my-skill", createSkillCtx());

    expect(result.slug).toBe("my-skill");
    expect(result.data).toEqual({ name: "My Skill", version: "1.0.0" } as any);
  });
});

describe("listSkillsWithCatalog", () => {
  beforeEach(() => {
    mockLoadSkillCatalog.mockReset();
    mockResolveSkillStates.mockReset();
    mockGetCatalog.mockReset();
  });

  test("merges installed with catalog, deduplicates", async () => {
    mockResolveSkillStates.mockReturnValue([
      { summary: makeSummary("weather", "bundled"), state: "enabled" },
    ]);
    mockGetCatalog.mockResolvedValue([
      {
        id: "weather",
        name: "Weather",
        description: "Weather skill",
        emoji: undefined,
      },
      {
        id: "doordash",
        name: "DoorDash",
        description: "Food delivery",
        emoji: undefined,
      },
    ]);

    const result = await listSkillsWithCatalog(createSkillCtx());

    const ids = result.map((s) => s.id);
    // weather should appear once (installed takes precedence)
    expect(ids.filter((id) => id === "weather")).toHaveLength(1);
    // doordash should appear from catalog
    expect(ids).toContain("doordash");
  });

  test("catalog fetch failure returns installed-only", async () => {
    mockResolveSkillStates.mockReturnValue([
      { summary: makeSummary("browser", "bundled"), state: "enabled" },
    ]);
    mockGetCatalog.mockRejectedValue(new Error("Network error"));

    const result = await listSkillsWithCatalog(createSkillCtx());

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("browser");
  });
});

describe("draftSkill", () => {
  beforeEach(() => {
    mockGetConfiguredProvider.mockReset();
    mockGetConfiguredProvider.mockResolvedValue(null);
    mockExtractText.mockReset();
    mockExtractText.mockReturnValue("");
    mockValidateManagedSkillId.mockReset();
    mockValidateManagedSkillId.mockReturnValue(null);
  });

  test("full frontmatter extracts all fields without LLM", async () => {
    const source = `---
name: Weather Checker
skill-id: weather-checker
description: Check weather conditions
emoji: "\u{1F324}\u{FE0F}"
---

# Weather Checker
Use this skill to check the weather.`;

    const result = await draftSkill({ sourceText: source }, createSkillCtx());

    expect(result.success).toBe(true);
    expect(result.draft?.skillId).toBe("weather-checker");
    expect(result.draft?.name).toBe("Weather Checker");
    expect(result.draft?.description).toBe("Check weather conditions");
    expect(result.warnings).toBeUndefined();
  });

  test("no frontmatter, no LLM → heuristic fallback with warnings", async () => {
    mockGetConfiguredProvider.mockResolvedValue(null);

    const result = await draftSkill(
      { sourceText: "# My Cool Skill\nDoes cool stuff." },
      createSkillCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.draft?.skillId).toBeTruthy();
    expect(result.draft?.name).toBeTruthy();
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("heuristic"))).toBe(true);
  });

  test("LLM available: calls provider for missing fields", async () => {
    const sendMessageMock = mock(async () => ({
      content: [{ type: "text", text: "unused" }],
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }));
    mockGetConfiguredProvider.mockResolvedValue({
      name: "mock",
      sendMessage: sendMessageMock,
    });
    mockExtractText.mockReturnValue(
      '{"skillId":"gen-skill","name":"Generated","description":"A generated skill","emoji":"\\u2728"}',
    );

    const result = await draftSkill(
      { sourceText: "Do something useful" },
      createSkillCtx(),
    );

    expect(result.success).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(result.draft?.skillId).toBe("gen-skill");
    expect(result.draft?.name).toBe("Generated");
  });

  test("LLM timeout → falls back to heuristic with warning", async () => {
    const sendMessageMock = mock(async () => {
      throw new Error("Timeout");
    });
    mockGetConfiguredProvider.mockResolvedValue({
      name: "mock",
      sendMessage: sendMessageMock,
    });

    const result = await draftSkill(
      { sourceText: "# Timeout Skill\nSome body text" },
      createSkillCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.draft?.skillId).toBeTruthy();
    expect(result.warnings).toBeDefined();
    expect(
      result.warnings!.some((w) => w.includes("LLM draft generation failed")),
    ).toBe(true);
  });

  test("skillId with special chars gets normalized", async () => {
    const source = `---
name: My Skill!!!
skill-id: My Skill!!!
description: test
emoji: "\u{1F4DD}"
---
Body`;

    const result = await draftSkill({ sourceText: source }, createSkillCtx());

    expect(result.success).toBe(true);
    // Special chars should be slugified
    expect(result.draft?.skillId).not.toContain("!");
    expect(result.draft?.skillId).toMatch(/^[a-z0-9]/);
  });
});

describe("createSkill", () => {
  beforeEach(() => {
    mockCreateManagedSkill.mockReset();
    mockCreateManagedSkill.mockReturnValue({ created: true });
    mockLoadRawConfig.mockReset();
    mockLoadRawConfig.mockReturnValue({});
    mockSaveRawConfig.mockReset();
    mockEnsureSkillEntry.mockReset();
    mockEnsureSkillEntry.mockReturnValue({});
    mockSeedSkillGraphNodes.mockReset();
  });

  test("valid params: creates, auto-enables, seeds, broadcasts", async () => {
    const ctx = createSkillCtx();

    const result = await createSkill(
      {
        skillId: "my-skill",
        name: "My Skill",
        description: "Does things",
        bodyMarkdown: "# My Skill\nContent",
      },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockCreateManagedSkill).toHaveBeenCalledTimes(1);
    expect(mockEnsureSkillEntry).toHaveBeenCalledWith(
      expect.any(Object),
      "my-skill",
    );
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
    expect(mockSeedSkillGraphNodes).toHaveBeenCalledTimes(1);
    expect(mockBroadcastCalls).toHaveLength(1);
    expect(mockBroadcastCalls[0].type).toBe("skills_state_changed");
    expect(mockBroadcastCalls[0].state).toBe("enabled");
  });

  test("already exists → returns error from createManagedSkill", async () => {
    mockCreateManagedSkill.mockReturnValue({
      created: false,
      error: "Skill already exists",
    });

    const result = await createSkill(
      {
        skillId: "existing",
        name: "Existing",
        description: "Already there",
        bodyMarkdown: "# X",
      },
      createSkillCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Skill already exists");
    }
  });

  test("auto-enable failure logs warning but still returns success", async () => {
    mockSaveRawConfig.mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await createSkill(
      {
        skillId: "new-skill",
        name: "New",
        description: "Fresh",
        bodyMarkdown: "# New",
      },
      createSkillCtx(),
    );

    // createSkill itself should still succeed — auto-enable failure is non-fatal
    expect(result).toEqual({ success: true });
    expect(mockSeedSkillGraphNodes).toHaveBeenCalledTimes(1);
  });
});

describe("postInstallSkill", () => {
  beforeEach(() => {
    mockLoadSkillCatalog.mockReset();
    mockLoadRawConfig.mockReset();
    mockLoadRawConfig.mockReturnValue({});
    mockSaveRawConfig.mockReset();
    mockEnsureSkillEntry.mockReset();
    mockEnsureSkillEntry.mockReturnValue({});
    mockSeedSkillGraphNodes.mockReset();
  });

  test("reloads catalog, auto-enables, broadcasts, seeds memory", () => {
    const ctx = createSkillCtx();

    postInstallSkill("weather", "/tmp/test-skills/weather", ctx);

    expect(mockLoadSkillCatalog).toHaveBeenCalledTimes(1);
    expect(mockEnsureSkillEntry).toHaveBeenCalledWith(
      expect.any(Object),
      "weather",
    );
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
    expect(mockSeedSkillGraphNodes).toHaveBeenCalledTimes(1);
    expect(mockBroadcastCalls).toHaveLength(1);
    expect(mockBroadcastCalls[0].type).toBe("skills_state_changed");
    expect(mockBroadcastCalls[0].name).toBe("weather");
    expect(mockBroadcastCalls[0].state).toBe("enabled");
  });
});
