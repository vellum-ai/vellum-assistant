import { describe, expect, test } from "bun:test";

import { toWorkspaceRelativePath } from "./workspace-path";

describe("toWorkspaceRelativePath", () => {
  test("strips a container-style /workspace root", () => {
    expect(toWorkspaceRelativePath("/workspace/scratch/figma-cli", "/workspace")).toBe(
      "scratch/figma-cli",
    );
  });

  test("strips a trailing slash on the path (as written in chat)", () => {
    expect(toWorkspaceRelativePath("/workspace/scratch/figma-cli/", "/workspace")).toBe(
      "scratch/figma-cli",
    );
  });

  test("strips a local absolute host root", () => {
    expect(
      toWorkspaceRelativePath(
        "/Users/example/.vellum/workspace/notes/todo.md",
        "/Users/example/.vellum/workspace",
      ),
    ).toBe("notes/todo.md");
  });

  test("tolerates a trailing slash on the root", () => {
    expect(toWorkspaceRelativePath("/workspace/a/b", "/workspace/")).toBe("a/b");
  });

  test("surrounding whitespace in the code span is ignored", () => {
    expect(toWorkspaceRelativePath("  /workspace/a  ", "/workspace")).toBe("a");
  });

  test("the root itself maps to the empty relative path", () => {
    expect(toWorkspaceRelativePath("/workspace", "/workspace")).toBe("");
    expect(toWorkspaceRelativePath("/workspace/", "/workspace")).toBe("");
  });

  test("returns null for paths outside the workspace root", () => {
    expect(toWorkspaceRelativePath("/etc/passwd", "/workspace")).toBeNull();
    expect(toWorkspaceRelativePath("scratch/figma-cli", "/workspace")).toBeNull();
    // A sibling whose name merely shares the root as a prefix must not match.
    expect(toWorkspaceRelativePath("/workspace-backup/a", "/workspace")).toBeNull();
  });

  test("returns null for non-path code spans", () => {
    expect(toWorkspaceRelativePath("npm install", "/workspace")).toBeNull();
    expect(toWorkspaceRelativePath("alice/figma-cli", "/workspace")).toBeNull();
  });

  test("returns null when the root is empty", () => {
    expect(toWorkspaceRelativePath("/workspace/a", "")).toBeNull();
  });
});
