import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    _opts?: { version?: string; projectRoot?: string },
  ): Promise<{
    success: boolean;
    error?: string;
    skillId?: string;
    skillDir?: string;
  }> => ({ success: true }),
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
const TEST_SKILLS_DIR = "/tmp/test-skills";
const installedSkillIds = new Set<string>();
const stagedSkillDirs = new Set<string>();
let stagingCounter = 0;

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [
    ...mockCatalogSkills(),
    ...[...installedSkillIds].map((id) => ({
      id,
      displayName: id,
      description: `Installed ${id}`,
      source: "managed",
      directoryPath: join(TEST_SKILLS_DIR, id),
      skillFilePath: join(TEST_SKILLS_DIR, id, "SKILL.md"),
    })),
  ],
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
mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: mockGetCatalog,
}));
mock.module("../skills/catalog-install.js", () => ({
  commitStagedSkillInstall: (skillId: string, stagedDir: string) => {
    if (!stagedSkillDirs.has(stagedDir)) {
      throw new Error(
        `Installed skill "${skillId}" is missing SKILL.md at the skill root`,
      );
    }
    stagedSkillDirs.delete(stagedDir);
    installedSkillIds.add(skillId);
  },
  createSkillInstallStagingDir: () => {
    const stagingDir = join(
      TEST_SKILLS_DIR,
      ".install-staging",
      `project-${stagingCounter++}`,
    );
    mkdirSync(join(stagingDir, "skills"), { recursive: true });
    return stagingDir;
  },
  installSkillDependenciesIfPresent: () => {},
  installSkillLocally: mockInstallSkillLocally,
}));
mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
}));
mock.module("../skills/managed-store.js", () => ({
  createManagedSkill: () => ({ created: true }),
  deleteManagedSkill: () => ({ deleted: true }),
  validateManagedSkillId: () => null,
}));
mock.module("../memory/graph/capability-seed.js", () => ({
  deleteSkillCapabilityNode: () => {},
  seedSkillGraphNodes: mockSeedSkillGraphNodes,
  seedUninstalledCatalogSkillMemories: async () => {},
}));
mock.module("../util/platform.js", () => ({
  getWorkspaceSkillsDir: () => TEST_SKILLS_DIR,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("installSkill routing", () => {
  beforeEach(() => {
    rmSync(TEST_SKILLS_DIR, { recursive: true, force: true });
    mkdirSync(TEST_SKILLS_DIR, { recursive: true });
    installedSkillIds.clear();
    stagedSkillDirs.clear();
    stagingCounter = 0;
    mockCatalogSkills.mockReset();
    mockClawhubInstall.mockReset();
    mockInstallExternalSkill.mockReset();
    mockGetCatalog.mockReset();
    mockInstallSkillLocally.mockReset();
    mockSeedSkillGraphNodes.mockReset();
    mockEnsureSkillEntry.mockReset();

    // Defaults
    mockCatalogSkills.mockReturnValue([]);
    mockClawhubInstall.mockImplementation(async (slug, opts) => {
      const skillId = slug.includes("/") ? slug.split("/").pop()! : slug;
      const projectRoot = opts?.projectRoot ?? TEST_SKILLS_DIR;
      const skillDir = stageClawhubSkill(projectRoot, skillId);
      return { success: true, skillId, skillDir };
    });
    mockInstallExternalSkill.mockResolvedValue(undefined);
    mockGetCatalog.mockResolvedValue([]);
    mockInstallSkillLocally.mockResolvedValue(undefined);
    mockSeedSkillGraphNodes.mockReturnValue(undefined);
    mockEnsureSkillEntry.mockReturnValue({ enabled: false });
  });

  function writeInstalledSkill(skillId: string): void {
    const skillDir = join(TEST_SKILLS_DIR, skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: "${skillId}"
description: "Installed test skill."
---

Body.
`,
      "utf-8",
    );
    installedSkillIds.add(skillId);
  }

  function stageClawhubSkill(projectRoot: string, skillId: string): string {
    const skillDir = join(projectRoot, "skills", skillId);
    stagedSkillDirs.add(skillDir);
    return skillDir;
  }

  test("install with origin: 'skillssh' and multi-segment slug routes to installExternalSkill", async () => {
    mockInstallExternalSkill.mockImplementation(async () => {
      writeInstalledSkill("react-best-practices");
    });

    const result = await installSkill({
      slug: "vercel-labs/agent-skills/react-best-practices",
      origin: "skillssh",
    });

    expect(result.success).toBe(true);
    expect(mockInstallExternalSkill).toHaveBeenCalledTimes(1);
    expect(mockInstallExternalSkill).toHaveBeenCalledWith(
      "vercel-labs",
      "agent-skills",
      "react-best-practices",
      true, // overwrite — handler default is true for HTTP API back-compat; CLI passes explicit false
      undefined, // ref
      undefined, // contactId
    );
    // Should not have called clawhub
    expect(mockClawhubInstall).not.toHaveBeenCalled();
  });

  test("install without origin falls through to clawhub for simple slugs", async () => {
    mockClawhubInstall.mockImplementation(async (slug: string) => {
      const skillDir = stageClawhubSkill(
        join(TEST_SKILLS_DIR, ".install-staging", "project-0"),
        slug,
      );
      return { success: true, skillId: slug, skillDir };
    });

    const result = await installSkill({ slug: "some-clawhub-skill" });

    expect(result.success).toBe(true);
    expect(mockClawhubInstall).toHaveBeenCalledTimes(1);
    expect(mockClawhubInstall).toHaveBeenCalledWith("some-clawhub-skill", {
      contactId: undefined,
      projectRoot: join(TEST_SKILLS_DIR, ".install-staging", "project-0"),
      version: undefined,
    });
    // Should not have called installExternalSkill
    expect(mockInstallExternalSkill).not.toHaveBeenCalled();
  });

  test("install with origin: 'clawhub' routes directly to clawhub without trying skills.sh", async () => {
    mockClawhubInstall.mockImplementation(async (slug: string) => {
      const skillDir = stageClawhubSkill(
        join(TEST_SKILLS_DIR, ".install-staging", "project-0"),
        slug,
      );
      return { success: true, skillId: slug, skillDir };
    });

    const result = await installSkill({ slug: "my-skill", origin: "clawhub" });

    expect(result.success).toBe(true);
    expect(mockClawhubInstall).toHaveBeenCalledTimes(1);
    expect(mockInstallExternalSkill).not.toHaveBeenCalled();
  });

  test("clawhub install fails when the installed skill root is not discoverable", async () => {
    mockClawhubInstall.mockResolvedValue({
      success: true,
      skillId: "missing-root-skill",
      skillDir: join(
        TEST_SKILLS_DIR,
        ".install-staging",
        "project-0",
        "skills",
        "missing-root-skill",
      ),
    });

    const result = await installSkill({
      slug: "missing-root-skill",
      origin: "clawhub",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("missing SKILL.md");
    }
  });

  test("multi-segment slug without explicit origin auto-routes to skills.sh", async () => {
    mockInstallExternalSkill.mockImplementation(async () => {
      writeInstalledSkill("my-skill");
    });

    const result = await installSkill({ slug: "owner/repo/my-skill" });

    expect(result.success).toBe(true);
    expect(mockInstallExternalSkill).toHaveBeenCalledTimes(1);
    expect(mockInstallExternalSkill).toHaveBeenCalledWith(
      "owner",
      "repo",
      "my-skill",
      true, // overwrite — handler default is true for HTTP API back-compat; CLI passes explicit false
      undefined, // ref
      undefined, // contactId
    );
    expect(mockClawhubInstall).not.toHaveBeenCalled();
  });

  test("multi-segment slug with origin: 'clawhub' skips skills.sh and routes to clawhub", async () => {
    mockClawhubInstall.mockImplementation(async (slug: string) => {
      const skillId = slug.split("/").pop()!;
      const skillDir = stageClawhubSkill(
        join(TEST_SKILLS_DIR, ".install-staging", "project-0"),
        skillId,
      );
      return { success: true, skillId, skillDir };
    });

    // Even though the slug looks like skills.sh format, explicit origin: "clawhub"
    // should override the auto-detection and go to clawhub
    const result = await installSkill({
      slug: "owner/repo/my-skill",
      origin: "clawhub",
    });

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

    const result = await installSkill({
      slug: "bundled-skill",
      origin: "skillssh",
    });

    expect(result.success).toBe(true);
    // Should have auto-enabled via ensureSkillEntry, not called external install
    expect(mockInstallExternalSkill).not.toHaveBeenCalled();
    expect(mockClawhubInstall).not.toHaveBeenCalled();
  });

  test("skills.sh install failure propagates error", async () => {
    mockInstallExternalSkill.mockRejectedValue(
      new Error("Skill not found in repo"),
    );

    const result = await installSkill({
      slug: "owner/repo/nonexistent-skill",
      origin: "skillssh",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Skill not found in repo");
    }
  });
});
