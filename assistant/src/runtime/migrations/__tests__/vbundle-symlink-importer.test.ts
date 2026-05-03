/**
 * Symlink-handling coverage for the buffer-mode `commitImport`.
 *
 * Scenarios:
 *   1. Round-trip: a typeflag-2 manifest entry is recreated as a real symlink
 *      under the workspace, points at its sibling regular file, and reads
 *      back its target's contents through the link.
 *   2. Defense-in-depth: a hand-built `preValidatedManifest` carrying a
 *      `..`-traversal `link_target` is skipped (not written), with a
 *      "escapes workspace" warning.
 *   3. Defense-in-depth: an absolute `link_target` ("/etc/passwd") is
 *      skipped with the same warning shape.
 *   4. Overwrite: an existing regular file at the symlink's target path is
 *      backed up, then replaced by the symlink. Backup contents match the
 *      pre-existing file.
 *   5. Symlink-overwrites-symlink: a different pre-existing symlink at the
 *      target path is replaced cleanly without an EEXIST.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { commitImport } from "../vbundle-importer.js";
import type { VBundleTarEntry } from "../vbundle-validator.js";
import { buildTestManifest, defaultV1Options } from "./v1-test-helpers.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vbundle-symlink-importer-"));
});

afterEach(() => {
  if (workspaceDir) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function makePathResolver(): DefaultPathResolver {
  // Pass a stub guardian persona resolver to avoid the production lookup
  // touching the real contact store during tests.
  return new DefaultPathResolver(workspaceDir, undefined, () => null);
}

describe("commitImport — symlinks", () => {
  test("round-trip: recreates a typeflag-2 entry as a real symlink", () => {
    const files = [
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
      {
        path: "workspace/skills/bar.md",
        data: new TextEncoder().encode("hello bar"),
      },
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "bar.md",
      },
    ];
    const { archive } = buildVBundle({ files, ...defaultV1Options() });

    const result = commitImport({
      archiveData: archive,
      pathResolver: makePathResolver(),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fooPath = join(workspaceDir, "skills/foo.md");
    expect(lstatSync(fooPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fooPath)).toBe("bar.md");
    expect(readFileSync(fooPath, "utf8")).toBe("hello bar");

    const fooReport = result.report.files.find(
      (f) => f.path === "workspace/skills/foo.md",
    );
    expect(fooReport).toBeDefined();
    expect(fooReport!.action).toBe("created");
    expect(fooReport!.size).toBe(0);
    expect(fooReport!.backup_path).toBeNull();
  });

  test("defense-in-depth: traversal link_target is skipped with warning", () => {
    // Bypass `validateVBundle` (which would reject the traversal first) by
    // handing `commitImport` a hand-built manifest + entries map.
    const linkTarget = "../../../tmp/escape";
    const archivePath = "workspace/skills/escape.md";
    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: "0".repeat(64),
          size_bytes: 8,
        },
        {
          path: archivePath,
          sha256: "0".repeat(64),
          size_bytes: 0,
          link_target: linkTarget,
        },
      ],
    });
    const entries = new Map<string, VBundleTarEntry>([
      [
        "workspace/data/db/assistant.db",
        {
          name: "workspace/data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
          size: 8,
        },
      ],
      [
        archivePath,
        {
          name: archivePath,
          data: new Uint8Array(0),
          size: 0,
          linkname: linkTarget,
        },
      ],
    ]);

    const result = commitImport({
      archiveData: new Uint8Array(0),
      pathResolver: makePathResolver(),
      preValidatedManifest: manifest,
      preValidatedEntries: entries,
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = result.report.files.find((f) => f.path === archivePath);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe("skipped");
    expect(
      result.report.warnings.some((w) => w.includes("escapes workspace")),
    ).toBe(true);

    // Nothing should have landed on disk for the rejected entry.
    expect(() => lstatSync(join(workspaceDir, "skills/escape.md"))).toThrow();
  });

  test("defense-in-depth: absolute link_target is skipped with warning", () => {
    const linkTarget = "/etc/passwd";
    const archivePath = "workspace/skills/abs.md";
    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: "0".repeat(64),
          size_bytes: 8,
        },
        {
          path: archivePath,
          sha256: "0".repeat(64),
          size_bytes: 0,
          link_target: linkTarget,
        },
      ],
    });
    const entries = new Map<string, VBundleTarEntry>([
      [
        "workspace/data/db/assistant.db",
        {
          name: "workspace/data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
          size: 8,
        },
      ],
      [
        archivePath,
        {
          name: archivePath,
          data: new Uint8Array(0),
          size: 0,
          linkname: linkTarget,
        },
      ],
    ]);

    const result = commitImport({
      archiveData: new Uint8Array(0),
      pathResolver: makePathResolver(),
      preValidatedManifest: manifest,
      preValidatedEntries: entries,
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = result.report.files.find((f) => f.path === archivePath);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe("skipped");
    expect(
      result.report.warnings.some((w) => w.includes("escapes workspace")),
    ).toBe(true);

    expect(() => lstatSync(join(workspaceDir, "skills/abs.md"))).toThrow();
  });

  test("overwrite: pre-existing regular file is backed up and replaced", () => {
    // Hand-build the manifest and skip `workspaceDir` so the workspace
    // clear (Step 1b) doesn't wipe the regular file we plant below — that
    // way we exercise the in-loop overwrite branch directly.
    const archivePath = "workspace/skills/foo.md";
    const linkTarget = "bar.md";

    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: "0".repeat(64),
          size_bytes: 8,
        },
        {
          path: archivePath,
          sha256: "0".repeat(64),
          size_bytes: 0,
          link_target: linkTarget,
        },
      ],
    });
    const entries = new Map<string, VBundleTarEntry>([
      [
        "workspace/data/db/assistant.db",
        {
          name: "workspace/data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
          size: 8,
        },
      ],
      [
        archivePath,
        {
          name: archivePath,
          data: new Uint8Array(0),
          size: 0,
          linkname: linkTarget,
        },
      ],
    ]);

    // Pre-create the conflicting regular file at the resolved target.
    const fooDiskPath = join(workspaceDir, "skills/foo.md");
    mkdirSync(dirname(fooDiskPath), { recursive: true });
    writeFileSync(fooDiskPath, "old");

    const result = commitImport({
      archiveData: new Uint8Array(0),
      pathResolver: makePathResolver(),
      preValidatedManifest: manifest,
      preValidatedEntries: entries,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(lstatSync(fooDiskPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fooDiskPath)).toBe("bar.md");

    const report = result.report.files.find((f) => f.path === archivePath)!;
    expect(report.action).toBe("overwritten");
    expect(report.backup_path).not.toBeNull();

    // A backup file matching the foo.md.backup-* glob should exist and
    // contain the pre-existing regular-file bytes.
    const skillsDir = join(workspaceDir, "skills");
    const siblings = readdirSync(skillsDir);
    const backups = siblings.filter((n) => n.startsWith("foo.md.backup-"));
    expect(backups.length).toBeGreaterThan(0);
    const backupContents = readFileSync(join(skillsDir, backups[0]), "utf8");
    expect(backupContents).toBe("old");
  });

  test("legacy prompts/USER.md symlink is skipped when guardian persona is already customized", () => {
    // Bundle ships prompts/USER.md as a symlink. The destination workspace
    // already has a customized guardian persona at users/<slug>.md, so the
    // import must skip the entry rather than clobber the user's content.
    // Hand-build the manifest and skip `workspaceDir` so the workspace
    // clear (Step 1b) doesn't wipe the customized persona we plant below.
    const archivePath = "prompts/USER.md";
    const linkTarget = "../skills/something.md";

    const customizedPersona = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

- Preferred name/reference: Real User
- Pronouns: she/her
- Locale: en-US
- Work role: Staff Engineer
- Goals: Ship drop-user-md
- Hobbies/fun: Reading papers
- Daily tools: Terminal, Vellum
`;

    const guardianPath = join(workspaceDir, "users/captain.md");
    mkdirSync(dirname(guardianPath), { recursive: true });
    writeFileSync(guardianPath, customizedPersona, "utf-8");

    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: "0".repeat(64),
          size_bytes: 8,
        },
        {
          path: archivePath,
          sha256: "0".repeat(64),
          size_bytes: 0,
          link_target: linkTarget,
        },
      ],
    });
    const entries = new Map<string, VBundleTarEntry>([
      [
        "workspace/data/db/assistant.db",
        {
          name: "workspace/data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
          size: 8,
        },
      ],
      [
        archivePath,
        {
          name: archivePath,
          data: new Uint8Array(0),
          size: 0,
          linkname: linkTarget,
        },
      ],
    ]);

    // Resolver returns the customized guardian persona path for prompts/USER.md.
    const resolver = new DefaultPathResolver(
      workspaceDir,
      undefined,
      () => guardianPath,
    );

    const result = commitImport({
      archiveData: new Uint8Array(0),
      pathResolver: resolver,
      preValidatedManifest: manifest,
      preValidatedEntries: entries,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The customized persona file must remain a regular file (NOT a symlink).
    const stat = lstatSync(guardianPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(readFileSync(guardianPath, "utf-8")).toBe(customizedPersona);

    // The import report must record the entry as skipped.
    const entry = result.report.files.find((f) => f.path === archivePath);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe("skipped");

    // Warning should mention the customized guardian persona.
    expect(
      result.report.warnings.some(
        (w) =>
          w.includes("guardian persona") && w.includes("already customized"),
      ),
    ).toBe(true);
  });

  test("symlink-overwrites-symlink: replaces an existing symlink without EEXIST", () => {
    const archivePath = "workspace/skills/foo.md";
    const linkTarget = "bar.md";

    const manifest = buildTestManifest({
      contents: [
        {
          path: "workspace/data/db/assistant.db",
          sha256: "0".repeat(64),
          size_bytes: 8,
        },
        {
          path: archivePath,
          sha256: "0".repeat(64),
          size_bytes: 0,
          link_target: linkTarget,
        },
      ],
    });
    const entries = new Map<string, VBundleTarEntry>([
      [
        "workspace/data/db/assistant.db",
        {
          name: "workspace/data/db/assistant.db",
          data: new TextEncoder().encode("db-bytes"),
          size: 8,
        },
      ],
      [
        archivePath,
        {
          name: archivePath,
          data: new Uint8Array(0),
          size: 0,
          linkname: linkTarget,
        },
      ],
    ]);

    // Pre-create a different symlink at the target path.
    const fooDiskPath = join(workspaceDir, "skills/foo.md");
    mkdirSync(dirname(fooDiskPath), { recursive: true });
    symlinkSync("other.md", fooDiskPath);

    const result = commitImport({
      archiveData: new Uint8Array(0),
      pathResolver: makePathResolver(),
      preValidatedManifest: manifest,
      preValidatedEntries: entries,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(lstatSync(fooDiskPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fooDiskPath)).toBe("bar.md");
  });
});
