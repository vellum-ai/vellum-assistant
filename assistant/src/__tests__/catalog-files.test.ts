/**
 * Unit tests for `skills/catalog-files.ts` — preview listings and single-file
 * content for catalog skills (installed or not).
 *
 * Covers:
 *   - sanitizeRelativePath (accepts safe, rejects traversal / absolute / null)
 *   - readCatalogSkillFiles dev-mode (reads from a temp fake repo skills dir,
 *     does NOT touch fetch)
 *   - readCatalogSkillFiles platform-mode (stubbed fetch with success + 500
 *     + 404 + network-error)
 *   - readCatalogSkillFileContent dev-mode (text, traversal rejection,
 *     binary, oversized)
 *   - readCatalogSkillFileContent platform-mode (text, binary, oversized,
 *     404, pre-fetch traversal rejection)
 *   - catalog-miss short-circuit (no fetch call when id unknown)
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CatalogSkill } from "../skills/catalog-install.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Suppress logger output
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockCatalog: CatalogSkill[] = [];
let mockRepoSkillsDir: string | undefined = undefined;

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => mockCatalog,
}));

mock.module("../skills/catalog-install.js", () => ({
  getRepoSkillsDir: () => mockRepoSkillsDir,
}));

let mockPlatformToken: string | null = null;
mock.module("../util/platform.ts", () => ({
  readPlatformToken: () => mockPlatformToken,
}));
mock.module("../util/platform.js", () => ({
  readPlatformToken: () => mockPlatformToken,
}));

let mockPlatformBaseUrl = "https://platform.test";
mock.module("../config/env.ts", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));
mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  readCatalogSkillFileContent,
  readCatalogSkillFiles,
  sanitizeRelativePath,
} from "../skills/catalog-files.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function installFetchThrow(error: Error): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetchCalls.push({ url, init });
    throw error;
  }) as unknown as FetchFn;
}

function installFetchForbidden(): void {
  fetchCalls = [];
  globalThis.fetch = (async () => {
    throw new Error("fetch should not have been called");
  }) as unknown as FetchFn;
}

// Temp directories created during tests, cleaned up in afterEach.
const tempDirs: string[] = [];

function makeTempSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "catalog-files-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(
  root: string,
  skillId: string,
  files: Record<string, string | Buffer>,
): string {
  const skillDir = join(root, skillId);
  mkdirSync(skillDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(skillDir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return skillDir;
}

function skill(id: string): CatalogSkill {
  return { id, name: id, description: id };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  mockCatalog = [];
  mockRepoSkillsDir = undefined;
  mockPlatformToken = null;
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
// sanitizeRelativePath
// ---------------------------------------------------------------------------

describe("sanitizeRelativePath", () => {
  test("accepts simple posix paths", () => {
    expect(sanitizeRelativePath("SKILL.md")).toBe("SKILL.md");
    expect(sanitizeRelativePath("tools/run.sh")).toBe("tools/run.sh");
    expect(sanitizeRelativePath("a/b/c.txt")).toBe("a/b/c.txt");
  });

  test("normalizes leading ./", () => {
    expect(sanitizeRelativePath("./x")).toBe("x");
    expect(sanitizeRelativePath("./tools/run.sh")).toBe("tools/run.sh");
  });

  test("normalizes backslashes to forward slashes", () => {
    expect(sanitizeRelativePath("tools\\run.sh")).toBe("tools/run.sh");
  });

  test("rejects empty strings", () => {
    expect(sanitizeRelativePath("")).toBeNull();
  });

  test("rejects parent-traversal", () => {
    expect(sanitizeRelativePath("..")).toBeNull();
    expect(sanitizeRelativePath("../x")).toBeNull();
    expect(sanitizeRelativePath("../../etc/passwd")).toBeNull();
  });

  test("rejects absolute unix paths", () => {
    expect(sanitizeRelativePath("/etc/passwd")).toBeNull();
    expect(sanitizeRelativePath("/")).toBeNull();
  });

  test("rejects windows drive-prefixed paths", () => {
    expect(sanitizeRelativePath("C:/win")).toBeNull();
    expect(sanitizeRelativePath("C:\\Windows")).toBeNull();
  });

  test("rejects paths that become absolute after ./ stripping", () => {
    // The leading `./` strip loop used to leave `/etc/passwd` behind, which
    // posix.normalize then passed through as an absolute path. The
    // post-normalization absolute-path check should reject each of these.
    expect(sanitizeRelativePath(".//etc/passwd")).toBeNull();
    expect(sanitizeRelativePath("./././/etc/passwd")).toBeNull();
    // The backslash normalizes to `/`, so `.\\/etc/passwd` becomes
    // `.//etc/passwd` before the strip loop, then `/etc/passwd`.
    expect(sanitizeRelativePath(".\\/etc/passwd")).toBeNull();
    // Windows-drive bypass via the same mechanism.
    expect(sanitizeRelativePath(".//C:/Windows/system32")).toBeNull();
  });

  test("rejects paths containing null bytes", () => {
    expect(sanitizeRelativePath("SKILL.md\0.png")).toBeNull();
    expect(sanitizeRelativePath("\0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readCatalogSkillFiles — dev mode
// ---------------------------------------------------------------------------

describe("readCatalogSkillFiles (dev mode)", () => {
  test("lists files from the repo skills dir without touching fetch", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", {
      "SKILL.md": "# hello",
      "tools/run.sh": "#!/bin/sh\necho hi\n",
      "data/img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entries = await readCatalogSkillFiles("my-skill");
    expect(entries).not.toBeNull();
    const paths = entries!.map((e) => e.path).sort();
    expect(paths).toEqual(["SKILL.md", "data/img.png", "tools/run.sh"]);

    const md = entries!.find((e) => e.path === "SKILL.md")!;
    expect(md.name).toBe("SKILL.md");
    expect(md.size).toBe("# hello".length);
    expect(md.isBinary).toBe(false);
    expect(md.content).toBeNull();

    const png = entries!.find((e) => e.path === "data/img.png")!;
    expect(png.name).toBe("img.png");
    expect(png.isBinary).toBe(true);
    expect(png.content).toBeNull();

    expect(fetchCalls.length).toBe(0);
  });

  test("returns null when skill id is not in the catalog (dev mode)", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", { "SKILL.md": "x" });
    mockRepoSkillsDir = root;
    mockCatalog = []; // not in catalog
    installFetchForbidden();

    expect(await readCatalogSkillFiles("my-skill")).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test("rejects a symlinked skill root and falls through to platform mode", async () => {
    // Reproduces the Codex P2 attack: an attacker (or a misconfigured dev)
    // creates <repoSkillsDir>/my-skill as a symlink pointing at an external
    // directory. Without the symlink-root check in `resolveCatalogSource`,
    // the dev-mode branch would happily walk the external directory,
    // because the realpath containment check downstream derives `realRoot`
    // from the already-resolved symlink target.
    //
    // Expected behavior: the dev-mode shortcut is rejected up-front, and
    // we fall through to platform mode — which in this test is stubbed
    // to return an empty file list. So `readCatalogSkillFiles` should
    // return the empty platform response, and `fetch` MUST be called
    // (proving the fall-through happened, rather than the dev-mode
    // shortcut silently reading from the external directory).
    const root = makeTempSkillsDir();
    const externalRoot = mkdtempSync(join(tmpdir(), "catalog-files-ext-"));
    tempDirs.push(externalRoot);

    // External directory populated with a real SKILL.md + a secret file
    // that must NOT be exposed by the listing.
    writeFileSync(join(externalRoot, "SKILL.md"), "# EXTERNAL SKILL");
    writeFileSync(join(externalRoot, "secret.txt"), "EXTERNAL_SECRET");

    // Symlink the skill root at `<root>/my-skill` to the external dir.
    symlinkSync(externalRoot, join(root, "my-skill"));

    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchMock(() => Response.json({ skill_id: "my-skill", files: [] }));

    const entries = await readCatalogSkillFiles("my-skill");

    // Fall-through should produce the platform response (empty array),
    // NOT the external directory contents.
    expect(entries).toEqual([]);

    // Confirm the dev-mode shortcut was bypassed: platform fetch was
    // called against the preview endpoint.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://platform.test/v1/skills/my-skill/files/",
    );
  });

  test("rejects a symlinked skill root for content reads and falls through to platform mode", async () => {
    // Direct reproduction for `readCatalogSkillFileContent`: with a
    // symlinked skill root, the dev branch must not read the external
    // file. Instead we should fall through to the platform endpoint and
    // return whatever the platform says.
    const root = makeTempSkillsDir();
    const externalRoot = mkdtempSync(join(tmpdir(), "catalog-files-ext-"));
    tempDirs.push(externalRoot);

    writeFileSync(join(externalRoot, "SKILL.md"), "EXTERNAL_SKILL_CONTENT");
    symlinkSync(externalRoot, join(root, "my-skill"));

    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchMock(() =>
      Response.json({
        path: "SKILL.md",
        name: "SKILL.md",
        size: 14,
        mime_type: "text/markdown",
        is_binary: false,
        content: "PLATFORM_CONTENT",
      }),
    );

    const entry = await readCatalogSkillFileContent("my-skill", "SKILL.md");
    expect(entry).not.toBeNull();
    // Content must be the platform payload, NOT the external file's
    // bytes — otherwise the fall-through didn't happen.
    expect(entry!.content).toBe("PLATFORM_CONTENT");
    expect(entry!.mimeType).toBe("text/markdown");

    // And fetch was called, confirming dev-mode was bypassed.
    expect(fetchCalls.length).toBe(1);
    const url = fetchCalls[0]!.url;
    expect(
      url.startsWith("https://platform.test/v1/skills/my-skill/files/content/"),
    ).toBe(true);
  });

  test("non-symlinked skill root still uses the dev-mode shortcut", async () => {
    // Sanity check: a normal directory-based skill root must still be
    // served from disk without touching fetch. This guards against the
    // symlink-rejection path collateral-damaging regular dev flows.
    const root = makeTempSkillsDir();
    writeSkill(root, "normal-skill", { "SKILL.md": "# normal\n" });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("normal-skill")];
    installFetchForbidden();

    const entries = await readCatalogSkillFiles("normal-skill");
    expect(entries).not.toBeNull();
    const paths = entries!.map((e) => e.path).sort();
    expect(paths).toEqual(["SKILL.md"]);
    // No platform round-trip happened.
    expect(fetchCalls.length).toBe(0);
  });

  test("filters hidden files and SKIP_DIRS from the listing", async () => {
    // Simulates a dev working on a catalog skill locally who has a
    // node_modules/, a .git/, and a .hidden.md file sitting next to
    // SKILL.md. The preview listing must only show SKILL.md — matching
    // the behavior of `readDirRecursive` in `daemon/handlers/skills.ts`
    // for installed skills.
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", {
      "SKILL.md": "# hello",
      "node_modules/foo.js": "module.exports = {};",
      "node_modules/nested/bar.js": "module.exports = {};",
      "__pycache__/cached.pyc": Buffer.from([0x00, 0x01, 0x02]),
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/config": "[core]\n",
      ".hidden.md": "secret",
      ".DS_Store": Buffer.from([0x00, 0x00]),
    });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entries = await readCatalogSkillFiles("my-skill");
    expect(entries).not.toBeNull();
    const paths = entries!.map((e) => e.path).sort();
    expect(paths).toEqual(["SKILL.md"]);
    expect(fetchCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readCatalogSkillFiles — platform mode
// ---------------------------------------------------------------------------

describe("readCatalogSkillFiles (platform mode)", () => {
  test("fetches file listing from the platform and maps it", async () => {
    mockRepoSkillsDir = undefined;
    mockCatalog = [skill("remote-skill")];
    mockPlatformToken = "tok-123";
    installFetchMock(() =>
      Response.json({
        skill_id: "remote-skill",
        files: [
          { path: "SKILL.md", name: "SKILL.md", size: 12, sha: "a" },
          { path: "data/img.png", name: "img.png", size: 200, sha: "b" },
        ],
      }),
    );

    const entries = await readCatalogSkillFiles("remote-skill");
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(2);

    // URL + headers
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://platform.test/v1/skills/remote-skill/files/",
    );
    const headers = (fetchCalls[0]!.init?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["X-Conversation-Token"]).toBe("tok-123");

    // Mapped entries: always content === null, isBinary from filename.
    const md = entries!.find((e) => e.path === "SKILL.md")!;
    expect(md.isBinary).toBe(false);
    expect(md.content).toBeNull();
    expect(md.mimeType).toBe("");

    const png = entries!.find((e) => e.path === "data/img.png")!;
    expect(png.isBinary).toBe(true);
    expect(png.content).toBeNull();
    expect(png.mimeType).toBe("");
  });

  test("does not set X-Conversation-Token when no token is present", async () => {
    mockCatalog = [skill("remote-skill")];
    mockPlatformToken = null;
    installFetchMock(() =>
      Response.json({ skill_id: "remote-skill", files: [] }),
    );

    await readCatalogSkillFiles("remote-skill");
    const headers = (fetchCalls[0]!.init?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(headers["X-Conversation-Token"]).toBeUndefined();
  });

  test("returns null on 500", async () => {
    mockCatalog = [skill("remote-skill")];
    installFetchMock(
      () => new Response("boom", { status: 500, statusText: "Server Error" }),
    );
    expect(await readCatalogSkillFiles("remote-skill")).toBeNull();
    expect(fetchCalls.length).toBe(1);
  });

  test("returns null on 404", async () => {
    mockCatalog = [skill("remote-skill")];
    installFetchMock(
      () => new Response("missing", { status: 404, statusText: "Not Found" }),
    );
    expect(await readCatalogSkillFiles("remote-skill")).toBeNull();
  });

  test("returns null on network error", async () => {
    mockCatalog = [skill("remote-skill")];
    installFetchThrow(new Error("ECONNRESET"));
    expect(await readCatalogSkillFiles("remote-skill")).toBeNull();
  });

  test("returns null without fetching when skill id missing from catalog", async () => {
    mockCatalog = [];
    installFetchForbidden();
    expect(await readCatalogSkillFiles("unknown")).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readCatalogSkillFileContent — dev mode
// ---------------------------------------------------------------------------

describe("readCatalogSkillFileContent (dev mode)", () => {
  test("returns inline UTF-8 content for a text file", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", { "SKILL.md": "# hello world\n" });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entry = await readCatalogSkillFileContent("my-skill", "SKILL.md");
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("SKILL.md");
    expect(entry!.name).toBe("SKILL.md");
    expect(entry!.isBinary).toBe(false);
    expect(entry!.content).toBe("# hello world\n");
    expect(fetchCalls.length).toBe(0);
  });

  test("rejects traversal paths without touching the filesystem", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", { "SKILL.md": "ok" });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    expect(
      await readCatalogSkillFileContent("my-skill", "../escape"),
    ).toBeNull();
    expect(
      await readCatalogSkillFileContent("my-skill", "/etc/passwd"),
    ).toBeNull();
    expect(await readCatalogSkillFileContent("my-skill", "..")).toBeNull();
    expect(await readCatalogSkillFileContent("my-skill", "")).toBeNull();
  });

  test("returns content=null for a binary file", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", {
      "img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entry = await readCatalogSkillFileContent("my-skill", "img.png");
    expect(entry).not.toBeNull();
    expect(entry!.isBinary).toBe(true);
    expect(entry!.content).toBeNull();
  });

  test("returns content=null for oversized text files", async () => {
    const root = makeTempSkillsDir();
    // Just over 2 MB of 'a'
    const oversized = "a".repeat(2 * 1024 * 1024 + 1);
    writeSkill(root, "my-skill", { "big.txt": oversized });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entry = await readCatalogSkillFileContent("my-skill", "big.txt");
    expect(entry).not.toBeNull();
    expect(entry!.isBinary).toBe(false);
    expect(entry!.content).toBeNull();
    expect(entry!.size).toBe(oversized.length);
  });

  test("returns null for a missing file", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", { "SKILL.md": "ok" });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    expect(
      await readCatalogSkillFileContent("my-skill", "does/not/exist.txt"),
    ).toBeNull();
  });

  test("returns null without fetching when skill id missing from catalog", async () => {
    mockCatalog = [];
    installFetchForbidden();
    expect(await readCatalogSkillFileContent("unknown", "SKILL.md")).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test("rejects symlinked files that point outside the skill root", async () => {
    // Create a temp skill root AND a separate external directory.
    const root = makeTempSkillsDir();
    const externalRoot = mkdtempSync(join(tmpdir(), "catalog-files-ext-"));
    tempDirs.push(externalRoot);

    // Write an "external secret" file completely outside the skill tree.
    const externalSecret = join(externalRoot, "secret.txt");
    writeFileSync(externalSecret, "EXTERNAL_SECRET");

    // Create the skill directory itself with a legitimate file.
    const skillDir = writeSkill(root, "my-skill", { "SKILL.md": "ok" });

    // Create a symlink INSIDE the skill dir pointing at the external file.
    const linkPath = join(skillDir, "link-to-secret.md");
    symlinkSync(externalSecret, linkPath);

    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entry = await readCatalogSkillFileContent(
      "my-skill",
      "link-to-secret.md",
    );
    expect(entry).toBeNull();

    // And the legitimate file is still readable, so the check didn't
    // collateral-damage normal requests.
    const ok = await readCatalogSkillFileContent("my-skill", "SKILL.md");
    expect(ok).not.toBeNull();
    expect(ok!.content).toBe("ok");
  });

  test("rejects files accessed through a symlinked parent directory", async () => {
    const root = makeTempSkillsDir();
    const externalRoot = mkdtempSync(join(tmpdir(), "catalog-files-ext-"));
    tempDirs.push(externalRoot);

    // External directory with a real file inside it.
    const externalDir = join(externalRoot, "external-dir");
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, "payload.txt"), "EXTERNAL_PAYLOAD");

    // Legitimate skill dir with a normal file.
    const skillDir = writeSkill(root, "my-skill", { "SKILL.md": "ok" });

    // Inside the skill dir, create a symlinked subdirectory that points at
    // the external directory. Then try to request
    // `escape/payload.txt` — lexically this is inside the skill root, but
    // the physical file lives outside.
    const escapeLink = join(skillDir, "escape");
    symlinkSync(externalDir, escapeLink);

    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entry = await readCatalogSkillFileContent(
      "my-skill",
      "escape/payload.txt",
    );
    expect(entry).toBeNull();
  });

  test("rejects dotfile paths and returns null without reading disk", async () => {
    // `.env` is a valid sanitized path (sanitizeRelativePath accepts it),
    // but the hidden-segment check must reject it so the catalog content
    // reader never exposes dotfiles, matching the listing API that hides
    // them. This preserves parity between listing and content endpoints.
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", {
      "SKILL.md": "ok",
      ".env": "SECRET=abc\n",
    });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    expect(await readCatalogSkillFileContent("my-skill", ".env")).toBeNull();
    expect(
      await readCatalogSkillFileContent("my-skill", ".git/config"),
    ).toBeNull();
    expect(
      await readCatalogSkillFileContent("my-skill", "docs/.hidden/file.md"),
    ).toBeNull();
  });

  test("rejects SKIP_DIRS paths and returns null without reading disk", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", {
      "SKILL.md": "ok",
      "node_modules/foo/index.js": "module.exports = {};",
    });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    expect(
      await readCatalogSkillFileContent(
        "my-skill",
        "node_modules/foo/index.js",
      ),
    ).toBeNull();
    expect(
      await readCatalogSkillFileContent("my-skill", "__pycache__/cached.pyc"),
    ).toBeNull();
    expect(
      await readCatalogSkillFileContent(
        "my-skill",
        "nested/node_modules/foo.js",
      ),
    ).toBeNull();
  });

  test("regular docs/readme.md still returns content (sanity)", async () => {
    const root = makeTempSkillsDir();
    writeSkill(root, "my-skill", {
      "docs/readme.md": "# readme\n",
    });
    mockRepoSkillsDir = root;
    mockCatalog = [skill("my-skill")];
    installFetchForbidden();

    const entry = await readCatalogSkillFileContent(
      "my-skill",
      "docs/readme.md",
    );
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("# readme\n");
    expect(entry!.name).toBe("readme.md");
  });
});

// ---------------------------------------------------------------------------
// readCatalogSkillFileContent — platform mode
// ---------------------------------------------------------------------------

describe("readCatalogSkillFileContent (platform mode)", () => {
  test("maps snake_case text response to camelCase entry", async () => {
    mockCatalog = [skill("remote-skill")];
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

    const entry = await readCatalogSkillFileContent("remote-skill", "SKILL.md");
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("SKILL.md");
    expect(entry!.name).toBe("SKILL.md");
    expect(entry!.size).toBe(14);
    expect(entry!.mimeType).toBe("text/markdown");
    expect(entry!.isBinary).toBe(false);
    expect(entry!.content).toBe("# hello world\n");

    expect(fetchCalls.length).toBe(1);
    const url = fetchCalls[0]!.url;
    expect(
      url.startsWith(
        "https://platform.test/v1/skills/remote-skill/files/content/",
      ),
    ).toBe(true);
    expect(url).toContain("path=SKILL.md");
  });

  test("preserves binary response (content=null, isBinary=true)", async () => {
    mockCatalog = [skill("remote-skill")];
    installFetchMock(() =>
      Response.json({
        path: "img.png",
        name: "img.png",
        size: 1024,
        mime_type: "image/png",
        is_binary: true,
        content: null,
      }),
    );

    const entry = await readCatalogSkillFileContent("remote-skill", "img.png");
    expect(entry).not.toBeNull();
    expect(entry!.isBinary).toBe(true);
    expect(entry!.content).toBeNull();
    expect(entry!.mimeType).toBe("image/png");
  });

  test("preserves oversized text response (content=null)", async () => {
    mockCatalog = [skill("remote-skill")];
    installFetchMock(() =>
      Response.json({
        path: "big.txt",
        name: "big.txt",
        size: 3 * 1024 * 1024,
        mime_type: "text/plain",
        is_binary: false,
        content: null,
      }),
    );

    const entry = await readCatalogSkillFileContent("remote-skill", "big.txt");
    expect(entry).not.toBeNull();
    expect(entry!.isBinary).toBe(false);
    expect(entry!.content).toBeNull();
    expect(entry!.size).toBe(3 * 1024 * 1024);
  });

  test("returns null on 404", async () => {
    mockCatalog = [skill("remote-skill")];
    installFetchMock(
      () => new Response("missing", { status: 404, statusText: "Not Found" }),
    );
    expect(
      await readCatalogSkillFileContent("remote-skill", "ghost.md"),
    ).toBeNull();
  });

  test("rejects traversal BEFORE making any fetch call", async () => {
    mockCatalog = [skill("remote-skill")];
    installFetchForbidden();
    expect(await readCatalogSkillFileContent("remote-skill", "..")).toBeNull();
    expect(
      await readCatalogSkillFileContent("remote-skill", "../etc/passwd"),
    ).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test("rejects hidden / SKIP_DIRS paths BEFORE making any fetch call", async () => {
    // Platform-mode defense in depth: even though the platform endpoint
    // would refuse these reads server-side, we must short-circuit in
    // `readCatalogSkillFileContent` so an attacker cannot use the daemon
    // as a probe channel (and so we avoid unnecessary network traffic).
    mockCatalog = [skill("remote-skill")];
    installFetchForbidden();
    expect(
      await readCatalogSkillFileContent("remote-skill", ".env"),
    ).toBeNull();
    expect(
      await readCatalogSkillFileContent("remote-skill", ".git/config"),
    ).toBeNull();
    expect(
      await readCatalogSkillFileContent(
        "remote-skill",
        "node_modules/foo/index.js",
      ),
    ).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  test("returns null without fetching when skill id missing from catalog", async () => {
    mockCatalog = [];
    installFetchForbidden();
    expect(await readCatalogSkillFileContent("unknown", "SKILL.md")).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });
});
