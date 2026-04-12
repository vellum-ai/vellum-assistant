/**
 * Tests for `getSkillFiles` provider chain fallback.
 *
 * When a skill id isn't resolvable via `findSkillById` (i.e. not installed
 * locally, not bundled, not a managed skill), `getSkillFiles` falls back to
 * the provider chain (vellum catalog → skills.sh → clawhub). Each provider
 * is tried in order until one returns data. When a skill IS resolved by
 * `findSkillById` but its on-disk directory is missing, `getSkillFiles`
 * returns a 404 without falling through to the provider chain so the
 * listing and detail responses agree on `isInstalled`.
 *
 * Coverage:
 *   - Uninstalled catalog skill: returns `{ skill: catalog/vellum/available, files }` with `content: null` for every entry.
 *   - Neither installed nor handled by any provider: returns 404.
 *   - Installed skill: preserves the disk-read behavior with inline `content`.
 *   - Installed skill with missing directory: returns 404 without consulting providers.
 *   - `catalogSkillToSlim` mapping: `metadata.vellum["display-name"]` wins over `cs.name`.
 *   - skills.sh-shaped ID not in vellum catalog returns files from skills.sh provider.
 *   - clawhub-shaped ID not in vellum catalog returns files from clawhub provider.
 *   - ID that no provider handles returns 404.
 *   - Provider priority: vellum provider is tried before skills.sh/clawhub.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { SlimSkillResponse } from "../daemon/message-types/skills.js";
import type { SkillFileEntry } from "../skills/catalog-files.js";
import type { SkillFileProvider } from "../skills/skill-file-provider.js";

// ---------------------------------------------------------------------------
// Mock state — mutated by individual tests via reset helpers below
// ---------------------------------------------------------------------------

type ResolvedSkillEntry = {
  summary: SkillSummary;
  state: "enabled" | "disabled";
};

let mockResolvedStates: ResolvedSkillEntry[] = [];

// Per-provider mock state
let mockVellumProvider: SkillFileProvider;
let mockSkillsshProvider: SkillFileProvider;
let mockClawhubProvider: SkillFileProvider;

// Track which providers were consulted
const providerCalls: Array<{
  provider: string;
  method: string;
  skillId: string;
}> = [];

function makeNoopProvider(name: string): SkillFileProvider {
  return {
    canHandle(_skillId: string): boolean {
      return false;
    },
    async listFiles(skillId: string): Promise<SkillFileEntry[] | null> {
      providerCalls.push({ provider: name, method: "listFiles", skillId });
      return null;
    },
    async readFileContent(
      skillId: string,
      _path: string,
    ): Promise<SkillFileEntry | null> {
      providerCalls.push({
        provider: name,
        method: "readFileContent",
        skillId,
      });
      return null;
    },
    async toSlimSkill(skillId: string): Promise<SlimSkillResponse | null> {
      providerCalls.push({ provider: name, method: "toSlimSkill", skillId });
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => mockResolvedStates,
  skillFlagKey: () => null,
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => [],
}));

// The provider factory functions are called once at module init and the
// returned objects are captured in the `fileProviders` array. To allow
// per-test mock reassignment, return proxy objects that delegate every
// method call to the CURRENT value of the mutable mock variable.
mock.module("../skills/catalog-files.js", () => ({
  catalogSkillToSlim: () => ({}),
  createVellumCatalogProvider: () => ({
    canHandle: (id: string) => mockVellumProvider.canHandle(id),
    listFiles: (id: string) => mockVellumProvider.listFiles(id),
    readFileContent: (id: string, p: string) =>
      mockVellumProvider.readFileContent(id, p),
    toSlimSkill: (id: string) => mockVellumProvider.toSlimSkill(id),
  }),
  hasHiddenOrSkippedSegment: () => false,
  readCatalogSkillFiles: async () => null,
  readCatalogSkillFileContent: async () => null,
  sanitizeRelativePath: (p: string) => p,
  SKIP_DIRS: new Set(["node_modules", "__pycache__", ".git"]),
}));

mock.module("../skills/skillssh-files.js", () => ({
  createSkillsShProvider: () => ({
    canHandle: (id: string) => mockSkillsshProvider.canHandle(id),
    listFiles: (id: string) => mockSkillsshProvider.listFiles(id),
    readFileContent: (id: string, p: string) =>
      mockSkillsshProvider.readFileContent(id, p),
    toSlimSkill: (id: string) => mockSkillsshProvider.toSlimSkill(id),
  }),
}));

mock.module("../skills/clawhub-files.js", () => ({
  createClawhubProvider: () => ({
    canHandle: (id: string) => mockClawhubProvider.canHandle(id),
    listFiles: (id: string) => mockClawhubProvider.listFiles(id),
    readFileContent: (id: string, p: string) =>
      mockClawhubProvider.readFileContent(id, p),
    toSlimSkill: (id: string) => mockClawhubProvider.toSlimSkill(id),
  }),
}));

mock.module("../skills/skill-file-provider.js", () => ({}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: async () => {},
  upsertSkillsIndex: () => {},
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
}));

mock.module("../skills/clawhub.js", () => ({
  clawhubCheckUpdates: async () => [],
  clawhubInspect: async () => ({}),
  clawhubInstall: async () => ({ success: true }),
  clawhubSearch: async () => ({ skills: [] }),
  clawhubUpdate: async () => ({ success: true }),
}));

mock.module("../skills/skillssh-registry.js", () => ({
  installExternalSkill: async () => {},
  resolveSkillSource: () => ({ owner: "", repo: "", skillSlug: "" }),
  searchSkillsRegistry: async () => [],
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

mock.module("../providers/provider-send-message.js", () => ({
  createTimeout: () => ({
    signal: AbortSignal.timeout(1000),
    cleanup: () => {},
  }),
  extractText: () => "",
  getConfiguredProvider: async () => null,
  userMessage: () => ({}),
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceSkillsDir: () => "/tmp/test-skills-fallback",
}));

mock.module("../daemon/handlers/shared.js", () => ({
  CONFIG_RELOAD_DEBOUNCE_MS: 100,
  ensureSkillEntry: (_raw: Record<string, unknown>, _id: string) => ({
    enabled: false,
  }),
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  _resetFileProvidersForTest,
  getSkillFiles,
} from "../daemon/handlers/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyCtx = {
  debounceTimers: { schedule: () => {} },
  setSuppressConfigReload: () => {},
  updateConfigFingerprint: () => {},
  broadcast: () => {},
} as unknown as Parameters<typeof getSkillFiles>[1];

function makeSummary(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: overrides.id ?? "summary-id",
    name: overrides.name ?? "summary-id",
    displayName: overrides.displayName ?? "Summary",
    description: overrides.description ?? "",
    directoryPath: overrides.directoryPath ?? "/tmp/nonexistent-skill-dir",
    skillFilePath:
      overrides.skillFilePath ??
      join(overrides.directoryPath ?? "/tmp/nonexistent-skill-dir", "SKILL.md"),
    source: overrides.source ?? "workspace",
    bundled: overrides.bundled,
    icon: overrides.icon,
    emoji: overrides.emoji,
    toolManifest: overrides.toolManifest,
    includes: overrides.includes,
    featureFlag: overrides.featureFlag,
    activationHints: overrides.activationHints,
    avoidWhen: overrides.avoidWhen,
    inlineCommandExpansions: overrides.inlineCommandExpansions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSkillFiles — provider chain fallback", () => {
  beforeEach(() => {
    mockResolvedStates = [];
    providerCalls.length = 0;
    mockVellumProvider = makeNoopProvider("vellum");
    mockSkillsshProvider = makeNoopProvider("skillssh");
    mockClawhubProvider = makeNoopProvider("clawhub");
    // Force provider chain re-creation from the (mocked) factory functions
    _resetFileProvidersForTest();
  });

  test("returns catalog skill with files (content: null) when skill is uninstalled but present in vellum catalog", async () => {
    const mockFiles: SkillFileEntry[] = [
      {
        path: "SKILL.md",
        name: "SKILL.md",
        size: 42,
        mimeType: "",
        isBinary: false,
        content: null,
      },
      {
        path: "assets/logo.png",
        name: "logo.png",
        size: 1024,
        mimeType: "",
        isBinary: true,
        content: null,
      },
    ];

    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => mockFiles,
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "acme-seo",
        name: "Acme SEO",
        description: "SEO helper",
        emoji: "\u{1F50D}",
        kind: "catalog",
        origin: "vellum",
        status: "available",
      }),
    };

    const result = await getSkillFiles("acme-seo", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.skill).toEqual({
      id: "acme-seo",
      name: "Acme SEO",
      description: "SEO helper",
      emoji: "\u{1F50D}",
      kind: "catalog",
      origin: "vellum",
      status: "available",
    });
    expect(result.files).toHaveLength(2);
    for (const entry of result.files) {
      expect(entry.content).toBeNull();
    }
    // Files should be sorted by path via localeCompare
    expect(result.files.map((f) => f.path)).toEqual(
      [...result.files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)),
    );
    expect(new Set(result.files.map((f) => f.path))).toEqual(
      new Set(["SKILL.md", "assets/logo.png"]),
    );
  });

  test("returns 404 when skill is neither installed nor handled by any provider", async () => {
    mockResolvedStates = [];

    const result = await getSkillFiles("ghost-skill", dummyCtx);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("ghost-skill");
  });

  test("returns 404 with 'files unavailable' when vellum provider canHandle returns true but listFiles returns null", async () => {
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async () => null,
      toSlimSkill: async () => null,
    };

    const result = await getSkillFiles("broken-skill", dummyCtx);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("broken-skill");
    expect(result.error).toContain("unavailable");
  });

  test("installed skill returns inline disk content (no provider fallback)", async () => {
    // Create a real temp directory for the installed-skill path to read.
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "vellum-skill-files-test-"),
    );
    const installedDir = join(workspaceRoot, "installed-skill");
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, "SKILL.md"),
      "# Installed\n\nBody of the installed skill.",
    );
    writeFileSync(
      join(installedDir, "notes.txt"),
      "Some notes about the skill.",
    );

    try {
      mockResolvedStates = [
        {
          summary: makeSummary({
            id: "installed-skill",
            name: "installed-skill",
            displayName: "Installed Skill",
            description: "A pre-installed skill",
            directoryPath: installedDir,
            source: "workspace",
          }),
          state: "enabled",
        },
      ];

      const result = await getSkillFiles("installed-skill", dummyCtx);

      expect("error" in result).toBe(false);
      if ("error" in result) return;

      expect(result.files).toHaveLength(2);
      const skillMd = result.files.find((f) => f.path === "SKILL.md");
      const notes = result.files.find((f) => f.path === "notes.txt");
      expect(skillMd).toBeDefined();
      expect(notes).toBeDefined();
      expect(skillMd!.content).toBe(
        "# Installed\n\nBody of the installed skill.",
      );
      expect(notes!.content).toBe("Some notes about the skill.");

      // Sort-by-path behavior (localeCompare order) is preserved.
      expect(result.files.map((f) => f.path)).toEqual(
        [...result.files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns 404 without provider fallback when installed skill directory is missing on disk", async () => {
    mockResolvedStates = [
      {
        summary: makeSummary({
          id: "ghost-installed",
          name: "ghost-installed",
          displayName: "Ghost Installed",
          description: "Installed in resolver but directory is gone",
          directoryPath: "/tmp/definitely-does-not-exist-" + Date.now(),
          source: "workspace",
        }),
        state: "enabled",
      },
    ];
    // Even if a provider would handle this id, the handler must NOT
    // fall through — return 404 instead.
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => [
        {
          path: "SKILL.md",
          name: "SKILL.md",
          size: 10,
          mimeType: "",
          isBinary: false,
          content: null,
        },
      ],
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "ghost-installed",
        name: "Ghost",
        description: "",
        kind: "catalog",
        origin: "vellum",
        status: "available",
      }),
    };

    const result = await getSkillFiles("ghost-installed", dummyCtx);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("ghost-installed");
    expect(result.error).toContain("directory missing");
  });

  test("catalogSkillToSlim falls back to cs.name when metadata.vellum.display-name is absent", async () => {
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => [],
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "plain-skill",
        name: "plain-skill",
        description: "Minimal",
        kind: "catalog",
        origin: "vellum",
        status: "available",
      }),
    };

    const result = await getSkillFiles("plain-skill", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.skill.name).toBe("plain-skill");
    expect(result.skill.kind).toBe("catalog");
    expect(result.skill.origin).toBe("vellum");
    expect(result.skill.status).toBe("available");
  });

  test("catalogSkillToSlim prefers metadata.vellum.display-name over cs.name", async () => {
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => [],
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "fancy-skill",
        name: "Pretty Fancy Name",
        description: "",
        kind: "catalog",
        origin: "vellum",
        status: "available",
      }),
    };

    const result = await getSkillFiles("fancy-skill", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.skill.name).toBe("Pretty Fancy Name");
  });

  test("skills.sh-shaped ID not in vellum catalog returns files from skills.sh provider", async () => {
    // Vellum provider doesn't handle this ID
    mockVellumProvider = {
      canHandle: () => false,
      listFiles: async () => null,
      readFileContent: async () => null,
      toSlimSkill: async () => null,
    };

    const skillsshFiles: SkillFileEntry[] = [
      {
        path: "SKILL.md",
        name: "SKILL.md",
        size: 100,
        mimeType: "",
        isBinary: false,
        content: null,
      },
    ];
    mockSkillsshProvider = {
      canHandle: (id: string) => id.split("/").length >= 3,
      listFiles: async () => skillsshFiles,
      readFileContent: async () => null,
      toSlimSkill: async (id: string) => ({
        id,
        name: "my-skill",
        description: "",
        kind: "catalog",
        origin: "skillssh",
        status: "available",
        slug: id,
        sourceRepo: "owner/repo",
        installs: 0,
      }),
    };

    const result = await getSkillFiles("owner/repo/my-skill", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.skill.origin).toBe("skillssh");
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("SKILL.md");
  });

  test("clawhub-shaped ID not in vellum catalog returns files from clawhub provider", async () => {
    // Vellum and skills.sh providers don't handle this ID
    mockVellumProvider = {
      canHandle: () => false,
      listFiles: async () => null,
      readFileContent: async () => null,
      toSlimSkill: async () => null,
    };
    mockSkillsshProvider = {
      canHandle: () => false,
      listFiles: async () => null,
      readFileContent: async () => null,
      toSlimSkill: async () => null,
    };

    const clawhubFiles: SkillFileEntry[] = [
      {
        path: "SKILL.md",
        name: "SKILL.md",
        size: 200,
        mimeType: "",
        isBinary: false,
        content: null,
      },
      {
        path: "lib/utils.js",
        name: "utils.js",
        size: 500,
        mimeType: "",
        isBinary: false,
        content: null,
      },
    ];
    mockClawhubProvider = {
      canHandle: () => true,
      listFiles: async () => clawhubFiles,
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "cool-tool",
        name: "Cool Tool",
        description: "A clawhub skill",
        kind: "catalog",
        origin: "clawhub",
        status: "available",
        slug: "cool-tool",
        author: "someone",
        stars: 5,
        installs: 10,
        reports: 0,
        version: "",
      }),
    };

    const result = await getSkillFiles("cool-tool", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.skill.origin).toBe("clawhub");
    expect(result.files).toHaveLength(2);
  });

  test("ID that no provider handles returns 404", async () => {
    // All providers return canHandle=false
    mockVellumProvider = makeNoopProvider("vellum");
    mockSkillsshProvider = makeNoopProvider("skillssh");
    mockClawhubProvider = makeNoopProvider("clawhub");

    const result = await getSkillFiles("unknown-origin-skill", dummyCtx);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
  });

  test("provider priority — vellum provider is tried before skills.sh and clawhub", async () => {
    // All three providers claim to handle this ID, but vellum should win
    const vellumListFilesCalls: string[] = [];
    const skillsshListFilesCalls: string[] = [];
    const clawhubListFilesCalls: string[] = [];

    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async (skillId: string) => {
        vellumListFilesCalls.push(skillId);
        return [
          {
            path: "SKILL.md",
            name: "SKILL.md",
            size: 10,
            mimeType: "",
            isBinary: false,
            content: null,
          },
        ];
      },
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "contested-skill",
        name: "Vellum Contested",
        description: "",
        kind: "catalog",
        origin: "vellum",
        status: "available",
      }),
    };
    mockSkillsshProvider = {
      canHandle: () => true,
      listFiles: async (skillId: string) => {
        skillsshListFilesCalls.push(skillId);
        return [];
      },
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "contested-skill",
        name: "Skillssh Contested",
        description: "",
        kind: "catalog",
        origin: "skillssh",
        status: "available",
        slug: "contested-skill",
        sourceRepo: "",
        installs: 0,
      }),
    };
    mockClawhubProvider = {
      canHandle: () => true,
      listFiles: async (skillId: string) => {
        clawhubListFilesCalls.push(skillId);
        return [];
      },
      readFileContent: async () => null,
      toSlimSkill: async () => ({
        id: "contested-skill",
        name: "Clawhub Contested",
        description: "",
        kind: "catalog",
        origin: "clawhub",
        status: "available",
        slug: "contested-skill",
        author: "",
        stars: 0,
        installs: 0,
        reports: 0,
        version: "",
      }),
    };

    const result = await getSkillFiles("contested-skill", dummyCtx);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // Vellum provider should have been used
    expect(result.skill.origin).toBe("vellum");
    expect(result.skill.name).toBe("Vellum Contested");
    // Vellum was called, but skills.sh and clawhub were NOT called
    expect(vellumListFilesCalls).toEqual(["contested-skill"]);
    expect(skillsshListFilesCalls).toEqual([]);
    expect(clawhubListFilesCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cleanup: ensure we don't leak temp dirs if a test fails mid-way.
// ---------------------------------------------------------------------------

afterEach(() => {
  // Nothing to clean up outside test scope — temp dirs are cleaned per-test.
});
