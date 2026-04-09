/**
 * Handler-level tests for `getSkillFileContent`.
 *
 * Covers:
 *   - Installed skill, valid path → returns file content (text + binary).
 *   - Installed skill, traversal path → 400 "Invalid path".
 *   - Installed skill, missing file → 404 "File not found".
 *   - Installed skill with missing on-disk directory → 404 "Skill directory
 *     missing" without consulting the catalog fallback.
 *   - Uninstalled catalog skill → delegates to `readCatalogSkillFileContent`
 *     and returns its payload; null result → 404.
 *   - Skill not found anywhere → 404.
 *   - Hidden / SKIP_DIRS path segments → rejected with 400 before touching
 *     either the installed-skill disk read or the catalog fallback.
 *
 * The test exercises the daemon handler directly — route wiring is a thin
 * pass-through to this function. The catalog-files module is mocked so the
 * handler's wiring is exercised in isolation; the helper's own dev-mode /
 * platform-mode behavior is covered in `catalog-files.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { SkillFileEntry } from "../skills/catalog-files.js";
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
// Ordered log of `readCatalogSkillFileContent` invocations so individual
// tests can assert that the catalog-fallback helper was (or was not)
// consulted. Mirrors the `catalogFilesCalls` array pattern used in
// `skills-files-catalog-fallback.test.ts` for `readCatalogSkillFiles`.
const catalogFileContentCalls: Array<{ skillId: string; path: string }> = [];
// Per-test override for the catalog fallback helper. When set, the
// `catalog-files.js` mock's `readCatalogSkillFileContent` delegates to
// this function, letting tests return canned payloads without touching
// disk or the network.
let mockCatalogFileContentResponder:
  | ((skillId: string, path: string) => Promise<SkillFileEntry | null>)
  | null = null;

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

// The `catalog-files.js` mock replaces `readCatalogSkillFileContent` with
// a spy wrapper that logs invocations and delegates to a per-test
// responder. Other exports (`sanitizeRelativePath`,
// `hasHiddenOrSkippedSegment`, `SKIP_DIRS`, `readCatalogSkillFiles`) are
// re-implemented inline from the production module so the handler's
// path-validation code still runs against equivalent logic without
// recursing back through the mocked module.
//
// The spy gives the new "installed skill directory missing" regression
// test a way to assert that the catalog fallback helper is NOT consulted
// when `findSkillById` resolves a ghost install — mirroring the
// `catalogFilesCalls.length === 0` assertion in
// `skills-files-catalog-fallback.test.ts`.
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
  // posix.normalize without the node import: collapse segments manually.
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

mock.module("../skills/catalog-files.js", () => ({
  SKIP_DIRS: INLINE_SKIP_DIRS,
  sanitizeRelativePath: inlineSanitizeRelativePath,
  hasHiddenOrSkippedSegment: inlineHasHiddenOrSkippedSegment,
  readCatalogSkillFiles: async () => null,
  readCatalogSkillFileContent: async (skillId: string, path: string) => {
    catalogFileContentCalls.push({ skillId, path });
    if (mockCatalogFileContentResponder) {
      return mockCatalogFileContentResponder(skillId, path);
    }
    return null;
  },
}));

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

function catalogSkill(id: string): CatalogSkill {
  return { id, name: id, description: id };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockResolvedSkills = [];
  mockCatalog = [];
  mockPlatformBaseUrl = "https://platform.test";
  catalogFileContentCalls.length = 0;
  mockCatalogFileContentResponder = null;
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
// Catalog fallback — helper invocation
// ---------------------------------------------------------------------------
//
// The daemon handler delegates to `readCatalogSkillFileContent` for any
// skill id that is not resolved locally but is present in the platform
// catalog. The helper's own dev-mode / platform-mode behavior is covered
// in detail in `catalog-files.test.ts`; these tests assert the handler
// wiring: the helper is invoked with the sanitized path, and the
// helper's result is returned on the response shape.

describe("getSkillFileContent — uninstalled catalog skill", () => {
  test("delegates to readCatalogSkillFileContent and returns the helper payload", async () => {
    // Skill is NOT in the installed catalog, but IS in the platform catalog.
    mockResolvedSkills = [];
    mockCatalog = [catalogSkill("remote-skill")];
    installFetchForbidden();

    mockCatalogFileContentResponder = async (_skillId, path) => ({
      path,
      name: "SKILL.md",
      size: 14,
      mimeType: "text/markdown",
      isBinary: false,
      content: "# hello world\n",
    });

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

    expect(catalogFileContentCalls).toEqual([
      { skillId: "remote-skill", path: "SKILL.md" },
    ]);
  });

  test("returns 404 when readCatalogSkillFileContent resolves to null", async () => {
    // Catalog helper returns null for a missing or unreadable file —
    // daemon handler translates that to 404 "File not found".
    mockResolvedSkills = [];
    mockCatalog = [catalogSkill("remote-skill")];
    installFetchForbidden();

    mockCatalogFileContentResponder = async () => null;

    const result = await getSkillFileContent(
      "remote-skill",
      "missing.md",
      dummyCtx,
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(404);
    expect(result.error).toBe("File not found");
    expect(catalogFileContentCalls).toEqual([
      { skillId: "remote-skill", path: "missing.md" },
    ]);
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
// Installed skill with missing directory (ghost install)
// ---------------------------------------------------------------------------
//
// When `findSkillById` resolves a skill as installed but the on-disk
// directory has disappeared (corrupted install, mid-delete race,
// external unmount), the handler must return a distinct 404 "Skill
// directory missing" instead of falling through to the catalog path.
// Falling through would flip the content response to a catalog payload
// even though `listSkillsWithCatalog` still classifies the same id as
// `kind: "installed"`, breaking the `isInstalled` contract between the
// listing and content responses. Mirrors the same fix on
// `getSkillFiles` verified by
// `skills-files-catalog-fallback.test.ts`.

describe("getSkillFileContent — installed skill with missing directory", () => {
  test("returns 404 without consulting the catalog when the installed dir is gone", async () => {
    mockResolvedSkills = [
      installedSkill(
        "ghost-installed",
        "/tmp/definitely-does-not-exist-" + Date.now(),
      ),
    ];
    // Even if the same id is present in the catalog, the handler must NOT
    // fall through. Prime both the catalog and a responder that would
    // return a successful payload to prove the short-circuit is active.
    mockCatalog = [catalogSkill("ghost-installed")];
    mockCatalogFileContentResponder = async () => ({
      path: "SKILL.md",
      name: "SKILL.md",
      size: 10,
      mimeType: "text/markdown",
      isBinary: false,
      content: "# from catalog\n",
    });
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
    // Catalog fallback must not have been consulted.
    expect(catalogFileContentCalls).toEqual([]);
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
    // handler BEFORE the catalog fallback, so the catalog helper should
    // never be consulted. We prime the responder with content that WOULD
    // succeed to prove that even though the fallback path would return a
    // payload, the daemon short-circuits first.
    mockResolvedSkills = []; // not installed
    mockCatalog = [catalogSkill("catalog-leaky")];
    installFetchForbidden();
    mockCatalogFileContentResponder = async () => ({
      path: ".env",
      name: ".env",
      size: 12,
      mimeType: "text/plain",
      isBinary: false,
      content: "SECRET=xyz\n",
    });

    const result = await getSkillFileContent("catalog-leaky", ".env", dummyCtx);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("Invalid path");
    // The hidden-segment check must run before the catalog helper.
    expect(catalogFileContentCalls).toEqual([]);
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
