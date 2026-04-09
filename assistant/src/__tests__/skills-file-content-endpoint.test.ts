/**
 * Handler-level tests for `getSkillFileContent`.
 *
 * Covers:
 *   - Installed skill, valid path → returns file content (text + binary).
 *   - Installed skill, traversal path → 400 "Invalid path".
 *   - Installed skill, missing path query handled upstream (route-level).
 *   - Uninstalled catalog skill, dev mode → content from repo path.
 *   - Uninstalled catalog skill, platform mode → content proxied from the
 *     platform file-content endpoint with snake_case → camelCase mapping.
 *   - Skill not found anywhere → 404.
 *
 * The test exercises the daemon handler directly — route wiring is a thin
 * pass-through to this function.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { CatalogSkill } from "../skills/catalog-install.js";

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
let mockCatalog: CatalogSkill[] = [];
let mockRepoSkillsDir: string | undefined = undefined;

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
  getCatalog: async () => mockCatalog,
}));

mock.module("../skills/catalog-install.js", () => ({
  installSkillLocally: async () => {},
  upsertSkillsIndex: () => {},
  getRepoSkillsDir: () => mockRepoSkillsDir,
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
import { getSkillFileContent } from "../daemon/handlers/skills.js";

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

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let originalFetch: FetchFn;
let fetchCalls: FetchCall[] = [];

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetchCalls.push({ url, init });
    return handler(url, init);
  }) as unknown as FetchFn;
}

function installFetchForbidden(): void {
  fetchCalls = [];
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

function catalogSkill(id: string): CatalogSkill {
  return { id, name: id, description: id };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  mockResolvedSkills = [];
  mockCatalog = [];
  mockRepoSkillsDir = undefined;
  mockPlatformBaseUrl = "https://platform.test";
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
// Catalog fallback — dev mode (uninstalled)
// ---------------------------------------------------------------------------

describe("getSkillFileContent — uninstalled catalog skill (dev mode)", () => {
  test("reads content from the repo skills dir without hitting the platform", async () => {
    // Skill is NOT in the installed catalog, but IS in the platform catalog
    // and exists on disk under the repo skills dir.
    const repoSkillsDir = mkdtempSync(
      join(tmpdir(), "skill-file-content-repo-"),
    );
    tempDirs.push(repoSkillsDir);
    const skillDir = join(repoSkillsDir, "dev-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# dev skill\n");

    mockRepoSkillsDir = repoSkillsDir;
    mockResolvedSkills = []; // not installed
    mockCatalog = [catalogSkill("dev-skill")];
    installFetchForbidden();

    const result = await getSkillFileContent("dev-skill", "SKILL.md", dummyCtx);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.path).toBe("SKILL.md");
    expect(result.name).toBe("SKILL.md");
    expect(result.content).toBe("# dev skill\n");
    expect(result.isBinary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Catalog fallback — platform mode (uninstalled, no repo checkout)
// ---------------------------------------------------------------------------

describe("getSkillFileContent — uninstalled catalog skill (platform mode)", () => {
  test("proxies content from the platform preview endpoint and maps snake_case → camelCase", async () => {
    mockResolvedSkills = []; // not installed
    mockCatalog = [catalogSkill("remote-skill")];
    mockRepoSkillsDir = undefined;
    installFetchMock(() =>
      Response.json({
        path: "SKILL.md",
        name: "SKILL.md",
        size: 14,
        mime_type: "text/markdown",
        is_binary: false,
        content: "# hello world\n",
      }),
    );

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

    // Verify the platform endpoint was actually called.
    expect(fetchCalls.length).toBe(1);
    expect(
      fetchCalls[0]!.url.startsWith(
        "https://platform.test/v1/skills/remote-skill/files/content/",
      ),
    ).toBe(true);
    expect(fetchCalls[0]!.url).toContain("path=SKILL.md");
  });
});

// ---------------------------------------------------------------------------
// Skill not found anywhere
// ---------------------------------------------------------------------------

describe("getSkillFileContent — skill not found", () => {
  test("returns 404 when the skill is neither installed nor in the catalog", async () => {
    mockResolvedSkills = [];
    mockCatalog = [];
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
// Hidden / SKIP_DIRS path rejection
// ---------------------------------------------------------------------------
//
// The daemon handler rejects paths containing dotfile segments (`.env`,
// `.git/`) or SKIP_DIRS segments (`node_modules`, `__pycache__`) with a
// 400 "Invalid path" BEFORE any disk read or network round-trip, matching
// the file-listing endpoint that hides these entries. This applies
// regardless of whether the skill is installed locally or only available
// via the catalog.

describe("getSkillFileContent — hidden / SKIP_DIRS rejection", () => {
  test("rejects dotfile reads from an installed skill with 400 Invalid path", async () => {
    // Set up an installed skill where a real `.env` file exists on disk.
    // Without the hidden-segment rejection, the handler would happily
    // read its content because sanitizeRelativePath accepts `.env`.
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

  test("rejects dotfile reads for an uninstalled catalog skill before any catalog read", async () => {
    // Same dotfile attack, but the skill id is NOT installed — only
    // present in the Vellum catalog. The rejection must run in the daemon
    // handler BEFORE the catalog fallback, so no disk walk or platform
    // fetch should happen. We use dev-mode with a real `.env` on disk
    // under the fake repo skills dir to prove that even though the
    // catalog path WOULD succeed without the check, the daemon
    // short-circuits.
    const repoSkillsDir = mkdtempSync(
      join(tmpdir(), "skill-file-content-hidden-repo-"),
    );
    tempDirs.push(repoSkillsDir);
    const catalogSkillDir = join(repoSkillsDir, "catalog-leaky");
    mkdirSync(catalogSkillDir, { recursive: true });
    writeFileSync(join(catalogSkillDir, "SKILL.md"), "# ok\n");
    writeFileSync(join(catalogSkillDir, ".env"), "SECRET=xyz\n");

    mockRepoSkillsDir = repoSkillsDir;
    mockResolvedSkills = []; // not installed
    mockCatalog = [catalogSkill("catalog-leaky")];
    installFetchForbidden();

    const result = await getSkillFileContent("catalog-leaky", ".env", dummyCtx);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("Invalid path");
  });

  test("rejects paths whose parent directory is a dotfile segment", async () => {
    // `.git/config` and `docs/.hidden/file.md` both contain hidden
    // segments even though the leaf isn't a dotfile.
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
    // Guards against collateral damage from the hidden/SKIP_DIRS filter:
    // a normal, non-hidden path must continue to work unchanged.
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
