import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

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

  test("no path args uses workingDir itself as the exact-dir ancestor", () => {
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

    // With no path args, workingDir itself (not its dirname) is the exact-dir
    // ancestor. A bare `ls` in /workspace/project/src should scope to
    // /workspace/project/src/*, not /workspace/project/*. The project
    // boundary above is still emitted as option 2.
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

  test("bare command inside a project scopes to cwd, not its parent", () => {
    // Regression for Codex P1 (Issue A): bare `ls` in /workspace/project/src
    // previously offered /workspace/project/* as the narrowest scope.
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "src");
    mkdirSync(subdir, { recursive: true });

    const result = generateDirectoryScopeOptions({
      pathArgs: [],
      workingDir: subdir,
      workspaceRoot: root,
    });

    // Without any project marker, option 2 is absent. Option 1 must be
    // subdir/*, not projectRoot/*.
    expect(result[0]).toEqual({
      scope: `${subdir}${sep}*`,
      label: "In src/",
    });
    for (const opt of result) {
      expect(opt.scope).not.toBe(`${projectRoot}${sep}*`);
    }
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

    // ~ resolves to homedir(); the single-path branch then applies dirname,
    // yielding e.g. /home or /Users — a strict ancestor of homedir(). Option
    // 1 is skipped because scoping to "all of /home/*" would include other
    // users' homes. The only non-everywhere option that may appear is a
    // project boundary above homedir (rare in sandboxes), so we can't
    // assert exact length — but neither homedir/* nor its parent/* may
    // appear as a scope.
    for (const opt of result) {
      expect(opt.scope).not.toBe(`${homedir()}${sep}*`);
      expect(opt.scope).not.toBe(`${dirname(homedir())}${sep}*`);
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

  test("ancestor outside workspaceRoot suppresses project-boundary option", () => {
    // Regression for Codex P1 (Issue B): findProjectBoundary used to run
    // unconditionally, so when the ancestor was outside workspaceRoot the
    // walk could escape the cap and surface an unrelated project as option 2.
    const wsRoot = mkdtempSync(join(tmpdir(), "dir-scope-ws-"));
    const otherRoot = mkdtempSync(join(tmpdir(), "dir-scope-other-"));
    // Plant a project marker inside the unrelated directory — it must NOT
    // be surfaced as option 2 for a target that lives under `otherRoot`.
    mkdirSync(join(otherRoot, ".git"));
    const otherFile = join(otherRoot, "file.ts");

    const result = generateDirectoryScopeOptions({
      pathArgs: [otherFile],
      workingDir: wsRoot,
      workspaceRoot: wsRoot,
    });

    // Ancestor is otherRoot, which is outside wsRoot. Option 1 is skipped
    // (isWithin check) and option 2 must also be skipped.
    expect(result).toEqual([{ scope: "everywhere", label: "Everywhere" }]);
    for (const opt of result) {
      expect(opt.scope).not.toBe(`${otherRoot}${sep}*`);
    }
  });

  test("duplicate identical path args behave like a single path", () => {
    // Regression for Devin (Issue C): commonAncestor's multi-path branch used
    // to return the full file path for duplicate inputs.
    const root = mkdtempSync(join(tmpdir(), "dir-scope-"));
    const projectRoot = join(root, "project");
    const subdir = join(projectRoot, "src");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(projectRoot, ".git"));

    const target = join(subdir, "file.ts");
    const duplicated = generateDirectoryScopeOptions({
      pathArgs: [target, target],
      workingDir: subdir,
      workspaceRoot: root,
    });
    const single = generateDirectoryScopeOptions({
      pathArgs: [target],
      workingDir: subdir,
      workspaceRoot: root,
    });

    // The ancestor must be the file's dirname, not the file path itself.
    expect(duplicated[0]).toEqual({
      scope: `${subdir}${sep}*`,
      label: "In src/",
    });
    for (const opt of duplicated) {
      expect(opt.scope).not.toBe(`${target}${sep}*`);
    }
    expect(duplicated).toEqual(single);
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
