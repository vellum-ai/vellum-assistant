/**
 * Tests for the symlink-aware directory walkers used by vbundle export.
 *
 * Two walkers exist (`walkDirectory` for the buffered path,
 * `walkDirectoryForMetadata` for the streaming path) and they must classify
 * symlinks identically: bundleable in-workspace targets become typeflag-2
 * entries, while broken / directory / outside-workspace / inside-skipDir
 * targets are dropped and reported. Each scenario below is exercised against
 * both walkers via describe.each so any drift between them fails loudly.
 *
 * One additional integration test drives `buildExportVBundle` end-to-end and
 * checks both that the dropped paths are summarized in a single aggregated
 * `log.warn` call and that a class-1 round-trip survives `validateVBundle`.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

const mockLogWarn = mock((_obj: unknown, _msg: string) => {});
mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    warn: mockLogWarn,
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
  }),
}));

const { buildExportVBundle, walkDirectory, walkDirectoryForMetadata } =
  await import("../vbundle-builder.js");
const { validateVBundle } = await import("../vbundle-validator.js");
const { defaultV1Options } = await import("./v1-test-helpers.js");

// ---------------------------------------------------------------------------
// Workspace fixtures
// ---------------------------------------------------------------------------

const cleanupQueue: string[] = [];

function makeTempDir(prefix: string): string {
  // Resolve to the canonical path so walker comparisons (which call
  // realpathSync on the symlink target) line up with the workspace root on
  // platforms where tmpdir() is itself a symlink (macOS: /var → /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupQueue.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupQueue.length > 0) {
    const dir = cleanupQueue.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  mockLogWarn.mockClear();
});

// ---------------------------------------------------------------------------
// Walker adapters — normalize both walker shapes to a common surface so the
// parametrized tests below can assert the same fields against either one.
// ---------------------------------------------------------------------------

interface NormalizedSymlinkEntry {
  archivePath: string;
  linkTarget: string;
}

interface NormalizedWalkResult {
  fileArchivePaths: string[];
  symlinks: NormalizedSymlinkEntry[];
  droppedSymlinks: string[];
}

interface WalkerAdapter {
  name: string;
  walk: (
    dir: string,
    prefix: string,
    skipDirs: string[],
  ) => NormalizedWalkResult;
}

const walkers: WalkerAdapter[] = [
  {
    name: "walkDirectory",
    walk: (dir, prefix, skipDirs) => {
      const result = walkDirectory(dir, prefix, {
        includeBinary: true,
        skipDirs,
      });
      return {
        fileArchivePaths: result.files
          .filter((f) => f.linkTarget === undefined)
          .map((f) => f.path),
        symlinks: result.files
          .filter((f) => f.linkTarget !== undefined)
          .map((f) => ({ archivePath: f.path, linkTarget: f.linkTarget! })),
        droppedSymlinks: result.droppedSymlinks,
      };
    },
  },
  {
    name: "walkDirectoryForMetadata",
    walk: (dir, prefix, skipDirs) => {
      const result = walkDirectoryForMetadata(dir, prefix, {
        includeBinary: true,
        skipDirs,
      });
      return {
        fileArchivePaths: result.files.map((f) => f.archivePath),
        symlinks: result.symlinks.map((s) => ({
          archivePath: s.archivePath,
          linkTarget: s.linkTarget,
        })),
        droppedSymlinks: result.droppedSymlinks,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Per-walker classification tests
// ---------------------------------------------------------------------------

describe.each(walkers)("$name — symlink classification", ({ walk }) => {
  test("class 1: in-workspace symlink is emitted with relative linkTarget", () => {
    const root = makeTempDir("vbundle-walker-class1-");
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "bar.md"), "bar contents");
    symlinkSync("bar.md", join(root, "skills", "foo.md"));

    const result = walk(root, "workspace", []);

    expect(result.droppedSymlinks).toEqual([]);
    expect(result.fileArchivePaths).toContain("workspace/skills/bar.md");
    expect(result.symlinks).toEqual([
      {
        archivePath: "workspace/skills/foo.md",
        linkTarget: "bar.md",
      },
    ]);
  });

  test("class 2: symlink targeting a path outside the workspace is dropped", () => {
    const root = makeTempDir("vbundle-walker-class2-");
    const outside = makeTempDir("vbundle-walker-outside-");
    mkdirSync(join(root, "skills"), { recursive: true });
    const outsideTarget = join(outside, "external.md");
    writeFileSync(outsideTarget, "external contents");
    symlinkSync(outsideTarget, join(root, "skills", "dev"));

    const result = walk(root, "workspace", []);

    expect(result.symlinks).toEqual([]);
    expect(result.droppedSymlinks).toContain(join("skills", "dev"));
  });

  test("class 3: symlink targeting a skipDir is dropped", () => {
    const root = makeTempDir("vbundle-walker-class3-");
    mkdirSync(join(root, "embedding-models"), { recursive: true });
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "embedding-models", "x.bin"), "blob");
    symlinkSync(
      join(root, "embedding-models", "x.bin"),
      join(root, "skills", "cache"),
    );

    const result = walk(root, "workspace", ["embedding-models"]);

    expect(result.symlinks).toEqual([]);
    expect(result.droppedSymlinks).toContain(join("skills", "cache"));
    // The skipDir itself is not walked, so its files are not emitted either.
    expect(result.fileArchivePaths).not.toContain(
      "workspace/embedding-models/x.bin",
    );
  });

  test("directory targets are out of scope and dropped", () => {
    const root = makeTempDir("vbundle-walker-dirtarget-");
    mkdirSync(join(root, "skills", "sub-dir"), { recursive: true });
    writeFileSync(join(root, "skills", "sub-dir", "nested.md"), "nested");
    symlinkSync(
      join(root, "skills", "sub-dir"),
      join(root, "skills", "dir-link"),
    );

    const result = walk(root, "workspace", []);

    expect(result.symlinks).toEqual([]);
    expect(result.droppedSymlinks).toContain(join("skills", "dir-link"));
    // The real sub-dir is still walked through normally.
    expect(result.fileArchivePaths).toContain(
      "workspace/skills/sub-dir/nested.md",
    );
  });

  test("broken symlinks are dropped without throwing", () => {
    const root = makeTempDir("vbundle-walker-broken-");
    mkdirSync(join(root, "skills"), { recursive: true });
    symlinkSync(
      join(root, "skills", "does-not-exist.md"),
      join(root, "skills", "broken"),
    );

    const result = walk(root, "workspace", []);

    expect(result.symlinks).toEqual([]);
    expect(result.droppedSymlinks).toContain(join("skills", "broken"));
  });

  test("class 1: in-workspace symlink is emitted when walk root is a non-canonical path with symlinked prefix", () => {
    // Intentionally NOT canonicalized — on macOS this stays as
    // /var/folders/... while realpathSync canonicalizes to
    // /private/var/folders/.... Without the realpathSync(walkRoot) fix in
    // classifySymlink, the containment check misclassifies in-workspace
    // symlinks as "outside workspace" and silently drops them.
    const ws = mkdtempSync(join(tmpdir(), "vbundle-walker-noncanon-"));
    cleanupQueue.push(ws);
    mkdirSync(join(ws, "skills"), { recursive: true });
    writeFileSync(join(ws, "skills", "bar.md"), "hello");
    symlinkSync("bar.md", join(ws, "skills", "foo.md"));

    const result = walk(ws, "workspace", []);

    expect(result.droppedSymlinks).toEqual([]);
    expect(result.symlinks).toEqual([
      {
        archivePath: "workspace/skills/foo.md",
        linkTarget: "bar.md",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Aggregated warning + round-trip integration
// ---------------------------------------------------------------------------

describe("buildExportVBundle aggregated symlink warning", () => {
  test("emits a single warn call covering every dropped symlink", () => {
    const root = makeTempDir("vbundle-walker-agg-");
    const outsideA = makeTempDir("vbundle-walker-agg-outA-");
    const outsideB = makeTempDir("vbundle-walker-agg-outB-");
    // Required workspace fixture so the walker has at least one regular file.
    writeFileSync(join(root, "config.json"), JSON.stringify({ test: true }));
    mkdirSync(join(root, "data", "db"), { recursive: true });
    writeFileSync(join(root, "data", "db", "assistant.db"), "fake-db");

    mkdirSync(join(root, "skills"), { recursive: true });
    mkdirSync(join(root, "embedding-models"), { recursive: true });
    writeFileSync(join(root, "embedding-models", "blob.bin"), "blob");

    const externalA = join(outsideA, "ext.md");
    const externalB = join(outsideB, "ext.md");
    writeFileSync(externalA, "ext-a");
    writeFileSync(externalB, "ext-b");

    symlinkSync(externalA, join(root, "skills", "ext-a"));
    symlinkSync(externalB, join(root, "skills", "ext-b"));
    symlinkSync(
      join(root, "embedding-models", "blob.bin"),
      join(root, "skills", "cache"),
    );

    buildExportVBundle({
      workspaceDir: root,
      ...defaultV1Options(),
    });

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [meta, msg] = mockLogWarn.mock.calls[0];
    expect(meta).toMatchObject({ count: 3 });
    expect((meta as { paths: string[] }).paths.sort()).toEqual(
      [
        join("skills", "cache"),
        join("skills", "ext-a"),
        join("skills", "ext-b"),
      ].sort(),
    );
    expect(typeof msg).toBe("string");
  });

  test("class-1 symlink survives buildExportVBundle round-trip via validateVBundle", () => {
    const root = makeTempDir("vbundle-walker-rt-");
    writeFileSync(join(root, "config.json"), JSON.stringify({ test: true }));
    mkdirSync(join(root, "data", "db"), { recursive: true });
    writeFileSync(join(root, "data", "db", "assistant.db"), "fake-db");
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "bar.md"), "bar contents");
    symlinkSync("bar.md", join(root, "skills", "foo.md"));

    const result = buildExportVBundle({
      workspaceDir: root,
      ...defaultV1Options(),
    });

    const validation = validateVBundle(result.archive);
    expect(validation.errors).toEqual([]);
    expect(validation.is_valid).toBe(true);

    const symlinkEntry = result.manifest.contents.find(
      (f) => f.path === "workspace/skills/foo.md",
    );
    expect(symlinkEntry).toBeDefined();
    expect(symlinkEntry?.link_target).toBe("bar.md");
    expect(symlinkEntry?.size_bytes).toBe(0);
  });
});
