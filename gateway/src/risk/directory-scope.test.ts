import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { generateDirectoryScopeOptions } from "./directory-scope.js";

describe("generateDirectoryScopeOptions", () => {
  test("single path under a project root emits three options", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "src");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    const target = join(subdir, "file.ts");
    const result = generateDirectoryScopeOptions({
      pathArgs: [target],
      workingDir: subdir,
      workspaceRoot: root,
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      scope: `${subdir}${sep}*`,
      label: "In src/",
    });
    expect(result[1]).toEqual({
      scope: `${projectRoot}${sep}*`,
      label: "In project/",
    });
    expect(result[2]).toEqual({ scope: "everywhere", label: "Everywhere" });
  });

  test("no path args uses workingDir as the sole target", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "src");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    const result = generateDirectoryScopeOptions({
      pathArgs: [],
      workingDir: subdir,
      workspaceRoot: root,
    });

    // With no path args, workingDir becomes the single target. Its dirname
    // is the project root, so the exact-dir option equals the project
    // boundary — dedup should collapse them to a single non-everywhere
    // option plus "everywhere".
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      scope: `${projectRoot}${sep}*`,
      label: "In project/",
    });
    expect(result[1]).toEqual({ scope: "everywhere", label: "Everywhere" });
  });

  test("multiple paths sharing a common ancestor use that ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "pkg", "sub");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    const result = generateDirectoryScopeOptions({
      pathArgs: [join(subdir, "a.ts"), join(subdir, "b.ts")],
      workingDir: projectRoot,
      workspaceRoot: root,
    });

    // Ancestor of [subdir/a.ts, subdir/b.ts] is subdir.
    expect(result[0]).toEqual({
      scope: `${subdir}${sep}*`,
      label: "In sub/",
    });
    expect(result).toContainEqual({
      scope: `${projectRoot}${sep}*`,
      label: "In project/",
    });
    expect(result[result.length - 1]).toEqual({
      scope: "everywhere",
      label: "Everywhere",
    });
  });

  test("paths with no common subtree collapse ancestor to root — option 1 omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    // Working dir inside a project so we can see whether the ancestor, not
    // the workingDir, drives the result.
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    const result = generateDirectoryScopeOptions({
      pathArgs: ["/a/b", "/c/d"],
      workingDir: projectRoot,
      workspaceRoot: root,
    });

    // Ancestor collapses to "/", so the exact-dir option is skipped. The
    // project boundary check starts at "/" which is outside workspaceRoot
    // (stopAt is inclusive → returns undefined), so option 2 is also
    // suppressed. Only "everywhere" remains.
    expect(result).toEqual([{ scope: "everywhere", label: "Everywhere" }]);
  });

  test("path resolving to ~ skips option 1", () => {
    const result = generateDirectoryScopeOptions({
      pathArgs: ["~"],
      workingDir: homedir(),
    });

    // ~ resolves to homedir → ancestor is homedir → option 1 skipped.
    // findProjectBoundary may or may not find something; the guarantee is
    // that everywhere appears and option 1 isn't `${homedir}/*`.
    for (const opt of result) {
      expect(opt.scope).not.toBe(`${homedir()}${sep}*`);
    }
    expect(result[result.length - 1]).toEqual({
      scope: "everywhere",
      label: "Everywhere",
    });
  });

  test("path resolving to / skips option 1", () => {
    if (sep !== "/") return; // POSIX-only check.
    const result = generateDirectoryScopeOptions({
      pathArgs: ["/"],
      workingDir: "/",
    });

    for (const opt of result) {
      expect(opt.scope).not.toBe(`/${sep}*`);
      expect(opt.scope).not.toBe(`${sep}*`);
    }
    expect(result[result.length - 1]).toEqual({
      scope: "everywhere",
      label: "Everywhere",
    });
  });

  test("boundary equal to exact dir is emitted only once (dedupe)", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    // Single path directly inside the project root → dirname is projectRoot,
    // which is also the project boundary. The dedupe logic should collapse
    // them into a single option plus "everywhere".
    const result = generateDirectoryScopeOptions({
      pathArgs: [join(projectRoot, "file.ts")],
      workingDir: projectRoot,
      workspaceRoot: root,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      scope: `${projectRoot}${sep}*`,
      label: "In project/",
    });
    expect(result[1]).toEqual({ scope: "everywhere", label: "Everywhere" });
  });

  test("workspaceRoot caps the project boundary search", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    // Place a marker ABOVE the workspace root so findProjectBoundary would
    // only see it if the walk escaped the cap.
    writeFileSync(join(root, "package.json"), "{}");
    const workspaceRoot = join(root, "workspace");
    const subdir = join(workspaceRoot, "inner");
    mkdirSync(subdir, { recursive: true });

    const result = generateDirectoryScopeOptions({
      pathArgs: [join(subdir, "file.ts")],
      workingDir: subdir,
      workspaceRoot,
    });

    // Exact dir is `subdir`. No marker between `subdir` and `workspaceRoot`
    // (inclusive), so findProjectBoundary returns undefined → no option 2.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      scope: `${subdir}${sep}*`,
      label: "In inner/",
    });
    expect(result[1]).toEqual({ scope: "everywhere", label: "Everywhere" });
  });

  test("boundary equal to workspaceRoot is suppressed", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const workspaceRoot = join(root, "ws");
    const subdir = join(workspaceRoot, "nested");
    mkdirSync(subdir, { recursive: true });
    // Marker lives ON the workspace root itself.
    mkdirSync(join(workspaceRoot, ".git"));

    const result = generateDirectoryScopeOptions({
      pathArgs: [join(subdir, "file.ts")],
      workingDir: subdir,
      workspaceRoot,
    });

    // findProjectBoundary(subdir, workspaceRoot) returns workspaceRoot, which
    // we explicitly suppress as option 2. Only exact-dir + everywhere remain.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      scope: `${subdir}${sep}*`,
      label: "In nested/",
    });
    expect(result[1]).toEqual({ scope: "everywhere", label: "Everywhere" });
  });

  test("relative path args resolve against workingDir", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "src");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    const result = generateDirectoryScopeOptions({
      pathArgs: ["file.ts"],
      workingDir: subdir,
      workspaceRoot: root,
    });

    // "file.ts" resolves to subdir/file.ts → dirname is subdir.
    expect(result[0]).toEqual({
      scope: `${subdir}${sep}*`,
      label: "In src/",
    });
  });

  test("output always contains everywhere as the last option", () => {
    const cases: {
      pathArgs: string[];
      workingDir: string;
      workspaceRoot?: string;
    }[] = [
      { pathArgs: [], workingDir: "/tmp" },
      { pathArgs: ["/a", "/b"], workingDir: "/tmp" },
      { pathArgs: ["~"], workingDir: "/tmp" },
      { pathArgs: ["/"], workingDir: "/" },
    ];
    for (const input of cases) {
      const result = generateDirectoryScopeOptions(input);
      expect(result.length).toBeGreaterThan(0);
      expect(result[result.length - 1]).toEqual({
        scope: "everywhere",
        label: "Everywhere",
      });
    }
  });

  test("does not mutate pathArgs input", () => {
    const pathArgs = Object.freeze(["/a/b/c"]);
    expect(() =>
      generateDirectoryScopeOptions({
        pathArgs,
        workingDir: "/tmp",
      }),
    ).not.toThrow();
  });
});
