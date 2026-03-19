import { describe, expect, test } from "bun:test";

import { renderWorkspaceTopLevelContext } from "../workspace/top-level-renderer.js";
import type { TopLevelSnapshot } from "../workspace/top-level-scanner.js";

describe("renderWorkspaceTopLevelContext", () => {
  test("renders basic snapshot with directories and files", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["lib", "src", "tests"],
      files: ["README.md", "package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toBe(
      [
        "<workspace_top_level>",
        "Root: /sandbox",
        "Directories: lib, src, tests",
        "Files: README.md, package.json",
        "</workspace_top_level>",
      ].join("\n"),
    );
  });

  test("includes truncation note when truncated", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["a", "b"],
      files: ["c.txt"],
      truncated: true,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toContain("(list truncated — more entries exist)");
    expect(result).toContain("Directories: a, b");
    expect(result).toContain("Files: c.txt");
  });

  test("does not include truncation note when not truncated", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["src"],
      files: ["index.ts"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).not.toContain("truncated");
  });

  test("renders empty directory and file lists", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/empty",
      directories: [],
      files: [],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toBe(
      [
        "<workspace_top_level>",
        "Root: /empty",
        "Directories: ",
        "Files: ",
        "</workspace_top_level>",
      ].join("\n"),
    );
  });

  test("produces stable output for equal input", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["alpha", "beta", "gamma"],
      files: ["config.json"],
      truncated: false,
    };

    const r1 = renderWorkspaceTopLevelContext(snapshot);
    const r2 = renderWorkspaceTopLevelContext(snapshot);
    expect(r1).toBe(r2);
  });

  test("starts with opening tag and ends with closing tag", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/test",
      directories: ["src"],
      files: [],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result.startsWith("<workspace_top_level>")).toBe(true);
    expect(result.endsWith("</workspace_top_level>")).toBe(true);
  });

  test("includes hidden directories", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/project",
      directories: [".git", ".vscode", "src"],
      files: [".gitignore"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toContain(".git");
    expect(result).toContain(".vscode");
    expect(result).toContain("src");
    expect(result).toContain(".gitignore");
  });

  test("renders files-only snapshot (no directories)", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/flat",
      directories: [],
      files: ["a.txt", "b.txt"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toContain("Directories: ");
    expect(result).toContain("Files: a.txt, b.txt");
  });

  test("renders current conversation and attachment paths when provided", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["src"],
      files: ["package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot, {
      currentConversationPath: "conversations/conv-1_2026-03-19T12-00-00.000Z/",
      currentConversationAttachmentsPath:
        "conversations/conv-1_2026-03-19T12-00-00.000Z/attachments/",
    });

    expect(result).toContain(
      "Current conversation folder: conversations/conv-1_2026-03-19T12-00-00.000Z/",
    );
    expect(result).toContain(
      "Attachment files: conversations/conv-1_2026-03-19T12-00-00.000Z/attachments/",
    );
  });
});
