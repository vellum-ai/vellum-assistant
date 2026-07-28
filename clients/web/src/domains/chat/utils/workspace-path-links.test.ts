import { describe, expect, test } from "bun:test";

import {
  toVellumWorkspaceHref,
  toWorkspaceRelativePath,
  workspaceBasenameOf,
  workspaceDirOf,
} from "@/domains/chat/utils/workspace-path-links";

describe("toWorkspaceRelativePath — accepted shapes", () => {
  test("absolute path under the hosted /workspace mount", () => {
    expect(
      toWorkspaceRelativePath("/workspace/drafts/v0.10.12-release-notes.md"),
    ).toBe("drafts/v0.10.12-release-notes.md");
  });

  test("absolute path under a desktop ~/.vellum/workspace mount", () => {
    // The mount point is deployment-specific, so recognition anchors on the
    // last `/workspace/` segment rather than a fixed prefix.
    expect(
      toWorkspaceRelativePath("/Users/alice/.vellum/workspace/drafts/notes.md"),
    ).toBe("drafts/notes.md");
  });

  test("absolute path to a workspace root file", () => {
    expect(toWorkspaceRelativePath("/workspace/SOUL.md")).toBe("SOUL.md");
  });

  test("relative path with a directory component", () => {
    expect(toWorkspaceRelativePath("drafts/notes.md")).toBe("drafts/notes.md");
  });

  test("leading ./ is normalized away", () => {
    expect(toWorkspaceRelativePath("./drafts/notes.md")).toBe(
      "drafts/notes.md",
    );
  });

  test("surrounding whitespace is trimmed", () => {
    expect(toWorkspaceRelativePath("  /workspace/drafts/notes.md  ")).toBe(
      "drafts/notes.md",
    );
  });

  test("extensionless files are accepted (existence decides)", () => {
    expect(toWorkspaceRelativePath("/workspace/scripts/Makefile")).toBe(
      "scripts/Makefile",
    );
  });
});

describe("toWorkspaceRelativePath — rejected shapes", () => {
  test("bare relative filename is too ambiguous to linkify", () => {
    // Indistinguishable from an ordinary backticked word.
    expect(toWorkspaceRelativePath("notes.md")).toBeNull();
  });

  test("absolute host path outside any workspace root", () => {
    expect(toWorkspaceRelativePath("/etc/passwd")).toBeNull();
    expect(toWorkspaceRelativePath("/Users/alice/Desktop/notes.md")).toBeNull();
  });

  test("home-relative path", () => {
    expect(toWorkspaceRelativePath("~/notes/todo.md")).toBeNull();
  });

  test("shell command containing a workspace path", () => {
    expect(toWorkspaceRelativePath("rm -rf /workspace/drafts")).toBeNull();
    expect(
      toWorkspaceRelativePath("cat /workspace/drafts/notes.md | head"),
    ).toBeNull();
  });

  test("glob pattern", () => {
    expect(toWorkspaceRelativePath("/workspace/skills/*/SKILL.md")).toBeNull();
    expect(toWorkspaceRelativePath("/workspace/logs/app.{1,2}.log")).toBeNull();
  });

  test("file:line reference", () => {
    expect(toWorkspaceRelativePath("/workspace/src/index.ts:42")).toBeNull();
  });

  test("URL", () => {
    expect(toWorkspaceRelativePath("https://example.com/a/b.md")).toBeNull();
  });

  test("directory shape (trailing slash)", () => {
    expect(toWorkspaceRelativePath("/workspace/drafts/")).toBeNull();
  });

  test("hidden segments — the tree listing omits them by default", () => {
    expect(
      toWorkspaceRelativePath("/workspace/.claude/settings.json"),
    ).toBeNull();
    expect(toWorkspaceRelativePath("drafts/.env")).toBeNull();
  });

  test("traversal segments", () => {
    expect(toWorkspaceRelativePath("/workspace/../etc/passwd")).toBeNull();
    expect(toWorkspaceRelativePath("drafts/../../etc/passwd")).toBeNull();
  });

  test("double slashes", () => {
    expect(toWorkspaceRelativePath("/workspace/drafts//notes.md")).toBeNull();
  });

  test("empty and oversized input", () => {
    expect(toWorkspaceRelativePath("")).toBeNull();
    expect(toWorkspaceRelativePath("   ")).toBeNull();
    expect(
      toWorkspaceRelativePath(`/workspace/${"a".repeat(600)}.md`),
    ).toBeNull();
  });
});

describe("path helpers", () => {
  test("workspaceDirOf", () => {
    expect(workspaceDirOf("drafts/notes.md")).toBe("drafts");
    expect(workspaceDirOf("a/b/c/notes.md")).toBe("a/b/c");
    expect(workspaceDirOf("SOUL.md")).toBe("");
  });

  test("workspaceBasenameOf", () => {
    expect(workspaceBasenameOf("drafts/notes.md")).toBe("notes.md");
    expect(workspaceBasenameOf("SOUL.md")).toBe("SOUL.md");
  });

  test("toVellumWorkspaceHref encodes per segment so slashes survive", () => {
    expect(toVellumWorkspaceHref("drafts/notes.md")).toBe(
      "vellum://workspace/drafts/notes.md",
    );
    // Non-ASCII names round-trip through the click handler's decodeURIComponent.
    expect(toVellumWorkspaceHref("drafts/notés.md")).toBe(
      "vellum://workspace/drafts/not%C3%A9s.md",
    );
  });
});
