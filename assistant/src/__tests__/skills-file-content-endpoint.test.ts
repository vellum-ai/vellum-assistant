/**
 * Handler-level tests for `getSkillFileContent`.
 *
 * Covers:
 *   - Installed skill, valid path → returns file content (text + binary).
 *   - Installed skill, traversal path → 400 "Invalid path".
 *   - Installed skill, missing file → 404 "File not found".
 *   - Installed skill with missing on-disk directory → 404 "Skill directory
 *     missing" without consulting the provider chain fallback.
 *   - Uninstalled vellum catalog skill → vellum provider returns content.
 *   - Uninstalled skills.sh skill → skills.sh provider returns content.
 *   - Uninstalled clawhub skill → clawhub provider returns content.
 *   - Skill not found anywhere → 404.
 *   - Hidden / SKIP_DIRS path segments → rejected with 400 before touching
 *     either the installed-skill disk read or the provider chain fallback.
 *
 * The test exercises the daemon handler directly — route wiring is a thin
 * pass-through to this function. The provider modules are mocked so the
 * handler's wiring is exercised in isolation.
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
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Suppress logger output
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
};
mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

// ── Mutable mock state ──────────────────────────────────────────────────────

let mockResolvedSkills: Array<{
  summary: SkillSummary;
  state: "enabled" | "disabled";
}> = [];

// Per-provider mock state
let mockVellumProvider: SkillFileProvider;
let mockSkillsshProvider: SkillFileProvider;
let mockClawhubProvider: SkillFileProvider;

// Track provider calls
const providerReadCalls: Array<{
  provider: string;
  skillId: string;
  path: string;
}> = [];

function makeNoopProvider(name: string): SkillFileProvider {
  return {
    canHandle(): boolean {
      return false;
    },
    async listFiles(): Promise<SkillFileEntry[] | null> {
      return null;
    },
    async readFileContent(
      skillId: string,
      path: string,
    ): Promise<SkillFileEntry | null> {
      providerReadCalls.push({ provider: name, skillId, path });
      return null;
    },
    async toSlimSkill(): Promise<SlimSkillResponse | null> {
      return null;
    },
  };
}

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => mockResolvedSkills.map((r) => r.summary),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => mockResolvedSkills,
  skillFlagKey: () => null,
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => [],
}));

// The `catalog-files.js` mock — provides path validation functions inline
// and delegates provider creation to mock state.
const INLINE_SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

function inlineSanitizeRelativePath(rawPath: string): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  if (rawPath.includes("\0")) return null;
  if (rawPath.startsWith("/")) return null;
  if (/^[a-zA-Z]:[/\\]/.test(rawPath)) return null;
  let candidate = rawPath.replace(/\\/g, "/");
  while (candidate.startsWith("./")) {
    candidate = candidate.slice(2);
  }
  if (candidate.length === 0) return null;
  const segments: string[] = [];
  for (const seg of candidate.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  const normalized = segments.join("/");
  if (normalized.startsWith("/")) return null;
  if (/^[a-zA-Z]:[/\\]/.test(normalized)) return null;
  return normalized;
}

function inlineHasHiddenOrSkippedSegment(sanitized: string): boolean {
  for (const segment of sanitized.split("/")) {
    if (segment.length === 0) continue;
    if (segment.startsWith(".")) return true;
    if (INLINE_SKIP_DIRS.has(segment)) return true;
  }
  return false;
}

// The provider factory functions are called once at module init and the
// returned objects are captured in the `fileProviders` array. To allow
// per-test mock reassignment, return proxy objects that delegate every
// method call to the CURRENT value of the mutable mock variable.
mock.module("../skills/catalog-files.js", () => ({
  SKIP_DIRS: INLINE_SKIP_DIRS,
  sanitizeRelativePath: inlineSanitizeRelativePath,
  hasHiddenOrSkippedSegment: inlineHasHiddenOrSkippedSegment,
  catalogSkillToSlim: () => ({}),
  createVellumCatalogProvider: () => ({
    canHandle: (id: string) => mockVellumProvider.canHandle(id),
    listFiles: (id: string) => mockVellumProvider.listFiles(id),
    readFileContent: (id: string, p: string) =>
      mockVellumProvider.readFileContent(id, p),
    toSlimSkill: (id: string) => mockVellumProvider.toSlimSkill(id),
  }),
  readCatalogSkillFiles: async () => null,
  readCatalogSkillFileContent: async () => null,
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
  getRepoSkillsDir: () => undefined,
}));

mock.module("../skills/catalog-search.js", () => ({
  filterByQuery: () => [],
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
  resolveSkillSource: () => {
    throw new Error("not used");
  },
  searchSkillsRegistry: mock(async () => []),
}));

mock.module("../skills/install-meta.js", () => ({
  readInstallMeta: () => null,
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

// Real isTextMimeType — we want actual classification here.
// No mock needed; let it fall through to the real implementation.

mock.module("../util/platform.js", () => ({
  getWorkspaceSkillsDir: () => "/tmp/test-skills",
  readPlatformToken: () => null,
}));
mock.module("../util/platform.ts", () => ({
  getWorkspaceSkillsDir: () => "/tmp/test-skills",
  readPlatformToken: () => null,
}));

let mockPlatformBaseUrl = "https://platform.test";
mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));
mock.module("../config/env.ts", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));

mock.module("../daemon/handlers/shared.js", () => ({
  CONFIG_RELOAD_DEBOUNCE_MS: 100,
  ensureSkillEntry: () => ({ enabled: false }),
  log: noopLogger,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { SkillOperationContext } from "../daemon/handlers/skills.js";
import {
  _resetFileProvidersForTest,
  getSkillFileContent,
} from "../daemon/handlers/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyCtx = {
  debounceTimers: { schedule: () => {} },
  setSuppressConfigReload: () => {},
  updateConfigFingerprint: () => {},
  broadcast: () => {},
} as unknown as SkillOperationContext;

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn;

function installFetchForbidden(): void {
  globalThis.fetch = (async () => {
    throw new Error("fetch should not have been called");
  }) as unknown as FetchFn;
}

const tempDirs: string[] = [];

function makeTempSkillDir(skillId: string): string {
  const root = mkdtempSync(join(tmpdir(), "skill-file-content-test-"));
  tempDirs.push(root);
  const skillDir = join(root, skillId);
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

function writeFile(dir: string, relPath: string, content: string | Buffer) {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function installedSkill(id: string, directoryPath: string) {
  return {
    summary: {
      id,
      name: id,
      displayName: id,
      description: id,
      directoryPath,
      skillFilePath: join(directoryPath, "SKILL.md"),
      source: "workspace" as const,
    },
    state: "enabled" as const,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockResolvedSkills = [];
  mockPlatformBaseUrl = "https://platform.test";
  providerReadCalls.length = 0;
  mockVellumProvider = makeNoopProvider("vellum");
  mockSkillsshProvider = makeNoopProvider("skillssh");
  mockClawhubProvider = makeNoopProvider("clawhub");
  // Force provider chain re-creation from the (mocked) factory functions
  _resetFileProvidersForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Installed-skill path
// ---------------------------------------------------------------------------

describe("getSkillFileContent — installed skill", () => {
  test("returns text file content for a valid path", async () => {
    const skillDir = makeTempSkillDir("my-skill");
    writeFile(skillDir, "SKILL.md", "# hello world\n");
    mockResolvedSkills = [installedSkill("my-skill", skillDir)];
    installFetchForbidden();

    const result = await getSkillFileContent("my-skill", "SKILL.md", dummyCtx);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.path).toBe("SKILL.md");
    expect(result.name).toBe("SKILL.md");
    expect(result.size).toBe("# hello world\n".length);
    expect(result.isBinary).toBe(false);
    expect(result.content).toBe("# hello world\n");
  });

  test("returns content=null for binary files", async () => {
    const skillDir = makeTempSkillDir("my-skill");
    writeFile(
      skillDir,
      "img.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    mockResolvedSkills = [installedSkill("my-skill", skillDir)];
    installFetchForbidden();

    const result = await getSkillFileContent("my-skill", "img.png", dummyCtx);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.isBinary).toBe(true);
    expect(result.content).toBeNull();
    expect(result.name).toBe("img.png");
  });

  test("rejects traversal paths with 400 Invalid path", async () => {
    const skillDir = makeTempSkillDir("my-skill");
    writeFile(skillDir, "SKILL.md", "ok");
    mockResolvedSkills = [installedSkill("my-skill", skillDir)];
    installFetchForbidden();

    for (const bad of ["../secrets", "..", "/etc/passwd", "./../escape"]) {
      const result = await getSkillFileContent("my-skill", bad, dummyCtx);
      expect("error" in result).toBe(true);
      if (!("error" in result)) continue;
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid path");
    }
  });

  test("rejects paths containing null bytes with 400", async () => {
    const skillDir = makeTempSkillDir("my-skill");
    writeFile(skillDir, "SKILL.md", "ok");
    mockResolvedSkills = [installedSkill("my-skill", skillDir)];
    installFetchForbidden();

    const result = await getSkillFileContent(
      "my-skill",
      "SKILL.md\0.png",
      dummyCtx,
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(400);
  });

  test("returns 404 for a missing file inside an installed skill", async () => {
    const skillDir = makeTempSkillDir("my-skill");
    writeFile(skillDir, "SKILL.md", "ok");
    mockResolvedSkills = [installedSkill("my-skill", skillDir)];
    installFetchForbidden();

    const result = await getSkillFileContent("my-skill", "ghost.txt", dummyCtx);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toBe("File not found");
  });
});

// ---------------------------------------------------------------------------
// Provider chain fallback — uninstalled skill content
// ---------------------------------------------------------------------------

describe("getSkillFileContent — uninstalled skill (provider chain)", () => {
  test("delegates to vellum provider and returns the payload", async () => {
    mockResolvedSkills = [];
    installFetchForbidden();

    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async (_skillId, path) => ({
        path,
        name: "SKILL.md",
        size: 14,
        mimeType: "text/markdown",
        isBinary: false,
        content: "# hello world\n",
      }),
      toSlimSkill: async () => null,
    };

    const result = await getSkillFileContent(
      "remote-skill",
      "SKILL.md",
      dummyCtx,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.path).toBe("SKILL.md");
    expect(result.name).toBe("SKILL.md");
    expect(result.size).toBe(14);
    expect(result.mimeType).toBe("text/markdown");
    expect(result.isBinary).toBe(false);
    expect(result.content).toBe("# hello world\n");
  });

  test("returns 404 when all providers return null", async () => {
    mockResolvedSkills = [];
    installFetchForbidden();

    // All providers return canHandle=false (default noop)

    const result = await getSkillFileContent(
      "ghost-skill",
      "SKILL.md",
      dummyCtx,
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toBe("Skill not found");
  });

  test("skills.sh content fallback", async () => {
    mockResolvedSkills = [];
    installFetchForbidden();

    // Vellum doesn't handle
    mockVellumProvider = makeNoopProvider("vellum");

    // skills.sh handles and returns content
    mockSkillsshProvider = {
      canHandle: (id: string) => id.split("/").length >= 3,
      listFiles: async () => null,
      readFileContent: async (_skillId, path) => ({
        path,
        name: "SKILL.md",
        size: 20,
        mimeType: "text/markdown",
        isBinary: false,
        content: "# skillssh content\n",
      }),
      toSlimSkill: async () => null,
    };

    const result = await getSkillFileContent(
      "owner/repo/my-skill",
      "SKILL.md",
      dummyCtx,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.content).toBe("# skillssh content\n");
    expect(result.path).toBe("SKILL.md");
  });

  test("clawhub content fallback", async () => {
    mockResolvedSkills = [];
    installFetchForbidden();

    // Vellum and skills.sh don't handle
    mockVellumProvider = makeNoopProvider("vellum");
    mockSkillsshProvider = makeNoopProvider("skillssh");

    // Clawhub handles and returns content
    mockClawhubProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async (_skillId, path) => ({
        path,
        name: "SKILL.md",
        size: 22,
        mimeType: "text/markdown",
        isBinary: false,
        content: "# clawhub content yo\n",
      }),
      toSlimSkill: async () => null,
    };

    const result = await getSkillFileContent("cool-tool", "SKILL.md", dummyCtx);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.content).toBe("# clawhub content yo\n");
    expect(result.path).toBe("SKILL.md");
  });

  test("returns 'File not found' when provider canHandle returns true but readFileContent returns null", async () => {
    mockResolvedSkills = [];
    installFetchForbidden();

    // Vellum provider claims this skill but returns null for the specific file
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async () => null,
      toSlimSkill: async () => null,
    };

    const result = await getSkillFileContent(
      "known-skill",
      "nonexistent.txt",
      dummyCtx,
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toBe("File not found");
  });

  test("stop-on-first-match: does not try clawhub when vellum canHandle returns true", async () => {
    mockResolvedSkills = [];
    installFetchForbidden();

    const clawhubReadCalls: string[] = [];

    // Vellum provider claims the skill but returns null for file content
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async () => null,
      toSlimSkill: async () => null,
    };

    // Clawhub would return content if asked, but should NOT be consulted
    mockClawhubProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async (_skillId, path) => {
        clawhubReadCalls.push(path);
        return {
          path,
          name: "SKILL.md",
          size: 10,
          mimeType: "text/markdown",
          isBinary: false,
          content: "# from clawhub\n",
        };
      },
      toSlimSkill: async () => null,
    };

    const result = await getSkillFileContent(
      "simple-slug",
      "SKILL.md",
      dummyCtx,
    );
    // Should be "File not found" (vellum handled but returned null)
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("File not found");
    // Clawhub should NOT have been called
    expect(clawhubReadCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Skill not found anywhere
// ---------------------------------------------------------------------------

describe("getSkillFileContent — skill not found", () => {
  test("returns 404 when the skill is neither installed nor handled by any provider", async () => {
    mockResolvedSkills = [];
    installFetchForbidden();

    const result = await getSkillFileContent(
      "ghost-skill",
      "SKILL.md",
      dummyCtx,
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toBe("Skill not found");
  });
});

// ---------------------------------------------------------------------------
// Installed skill with missing directory (ghost install)
// ---------------------------------------------------------------------------

describe("getSkillFileContent — installed skill with missing directory", () => {
  test("returns 404 without consulting providers when the installed dir is gone", async () => {
    mockResolvedSkills = [
      installedSkill(
        "ghost-installed",
        "/tmp/definitely-does-not-exist-" + Date.now(),
      ),
    ];
    // Even if a provider would return content, the handler must NOT
    // fall through.
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async () => ({
        path: "SKILL.md",
        name: "SKILL.md",
        size: 10,
        mimeType: "text/markdown",
        isBinary: false,
        content: "# from provider\n",
      }),
      toSlimSkill: async () => null,
    };
    installFetchForbidden();

    const result = await getSkillFileContent(
      "ghost-installed",
      "SKILL.md",
      dummyCtx,
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("ghost-installed");
    expect(result.error).toContain("directory missing");
    // Provider chain must not have been consulted.
    expect(providerReadCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hidden / SKIP_DIRS path rejection
// ---------------------------------------------------------------------------

describe("getSkillFileContent — hidden / SKIP_DIRS rejection", () => {
  test("rejects dotfile reads from an installed skill with 400 Invalid path", async () => {
    const skillDir = makeTempSkillDir("leaky-skill");
    writeFile(skillDir, "SKILL.md", "# ok\n");
    writeFile(skillDir, ".env", "SECRET=abc\n");
    mockResolvedSkills = [installedSkill("leaky-skill", skillDir)];
    installFetchForbidden();

    const result = await getSkillFileContent("leaky-skill", ".env", dummyCtx);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("Invalid path");
  });

  test("rejects dotfile reads for an uninstalled skill before any provider read", async () => {
    mockResolvedSkills = []; // not installed
    installFetchForbidden();
    mockVellumProvider = {
      canHandle: () => true,
      listFiles: async () => null,
      readFileContent: async () => ({
        path: ".env",
        name: ".env",
        size: 12,
        mimeType: "text/plain",
        isBinary: false,
        content: "SECRET=xyz\n",
      }),
      toSlimSkill: async () => null,
    };

    const result = await getSkillFileContent("catalog-leaky", ".env", dummyCtx);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("Invalid path");
    // The hidden-segment check must run before the provider chain.
    expect(providerReadCalls).toEqual([]);
  });

  test("rejects paths whose parent directory is a dotfile segment", async () => {
    const skillDir = makeTempSkillDir("my-skill");
    writeFile(skillDir, "SKILL.md", "# ok\n");
    mockResolvedSkills = [installedSkill("my-skill", skillDir)];
    installFetchForbidden();

    for (const bad of [".git/config", "docs/.hidden/file.md"]) {
      const result = await getSkillFileContent("my-skill", bad, dummyCtx);
      expect("error" in result).toBe(true);
      if (!("error" in result)) continue;
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid path");
    }
  });

  test("rejects paths inside SKIP_DIRS segments with 400 Invalid path", async () => {
    const skillDir = makeTempSkillDir("my-skill");
    writeFile(skillDir, "SKILL.md", "# ok\n");
    mockResolvedSkills = [installedSkill("my-skill", skillDir)];
    installFetchForbidden();

    for (const bad of [
      "node_modules/foo/index.js",
      "__pycache__/cached.pyc",
      "nested/node_modules/mod/index.js",
    ]) {
      const result = await getSkillFileContent("my-skill", bad, dummyCtx);
      expect("error" in result).toBe(true);
      if (!("error" in result)) continue;
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid path");
    }
  });

  test("regular SKILL.md still reads successfully (sanity)", async () => {
    const skillDir = makeTempSkillDir("healthy-skill");
    writeFile(skillDir, "SKILL.md", "# hello\n");
    mockResolvedSkills = [installedSkill("healthy-skill", skillDir)];
    installFetchForbidden();

    const result = await getSkillFileContent(
      "healthy-skill",
      "SKILL.md",
      dummyCtx,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.content).toBe("# hello\n");
    expect(result.name).toBe("SKILL.md");
  });
});
