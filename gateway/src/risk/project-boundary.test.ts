import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { findProjectBoundary } from "./project-boundary.js";

describe("findProjectBoundary", () => {
  test("finds .git directory when walking up from a subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "project-boundary-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "src", "deep", "nested");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    expect(findProjectBoundary(subdir, root)).toBe(projectRoot);
  });

  test("finds package.json when it appears higher than .git-less intermediate dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "project-boundary-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "src", "a", "b");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), "{}");

    expect(findProjectBoundary(subdir, root)).toBe(projectRoot);
  });

  test("returns undefined when no marker exists anywhere up to stopAt", () => {
    const root = mkdtempSync(join(tmpdir(), "project-boundary-"));
    const subdir = join(root, "a", "b", "c");
    mkdirSync(subdir, { recursive: true });

    expect(findProjectBoundary(subdir, root)).toBeUndefined();
  });

  test("respects stopAt as inclusive upper bound", () => {
    const root = mkdtempSync(join(tmpdir(), "project-boundary-"));
    // Place a marker ABOVE the stopAt boundary — findProjectBoundary must
    // not see it, because the walk halts inclusively at stopAt.
    writeFileSync(join(root, "package.json"), "{}");
    const stopAt = join(root, "inner");
    const subdir = join(stopAt, "a", "b");
    mkdirSync(subdir, { recursive: true });

    expect(findProjectBoundary(subdir, stopAt)).toBeUndefined();
  });

  test("handles the edge case where startDir itself contains a marker", () => {
    const root = mkdtempSync(join(tmpdir(), "project-boundary-"));
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "Makefile"), "");

    expect(findProjectBoundary(projectRoot, root)).toBe(projectRoot);
  });

  test("does not throw on nonexistent start path", () => {
    const root = mkdtempSync(join(tmpdir(), "project-boundary-"));
    const ghost = join(root, "does", "not", "exist");

    expect(() => findProjectBoundary(ghost, root)).not.toThrow();
    expect(findProjectBoundary(ghost, root)).toBeUndefined();
  });

  test("recognizes each additional marker (Cargo.toml, go.mod, pyproject.toml)", () => {
    for (const marker of ["Cargo.toml", "go.mod", "pyproject.toml"] as const) {
      const root = mkdtempSync(join(tmpdir(), "project-boundary-"));
      const projectRoot = join(root, "project");
      const subdir = join(projectRoot, "child");
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(projectRoot, marker), "");

      expect(findProjectBoundary(subdir, root)).toBe(projectRoot);
    }
  });

  test("walk terminates cleanly when reaching the filesystem root", () => {
    // sep is the filesystem root on POSIX ("/"); on Windows it's a drive
    // separator, so skip there. The walk should not loop forever even if
    // stopAt is not provided and no marker is found.
    if (sep !== "/") return;
    // Use a path unlikely to contain markers near the root. We don't assert
    // the return value (the real "/" might legitimately have a .git), only
    // that the call returns without hanging or throwing.
    expect(() => findProjectBoundary("/nonexistent-xyz-findboundary")).not.toThrow();
  });
});
