import { homedir, userInfo } from "node:os";
import { describe, expect, test } from "bun:test";

import { renderWorkspaceTopLevelContext } from "../workspace/top-level-renderer.js";
import type { TopLevelSnapshot } from "../workspace/top-level-scanner.js";

describe("renderWorkspaceTopLevelContext", () => {
  test("renders basic snapshot with directories, files, and host env", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["lib", "src", "tests"],
      files: ["README.md", "package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toBe(
      [
        "<workspace>",
        "Root: /sandbox",
        "Directories: lib, src, tests",
        "Files: README.md, package.json",
        `Host home directory: ${homedir()}`,
        `Host username: ${userInfo().username}`,
        "</workspace>",
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
        "<workspace>",
        "Root: /empty",
        "Directories: ",
        "Files: ",
        `Host home directory: ${homedir()}`,
        `Host username: ${userInfo().username}`,
        "</workspace>",
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
    expect(result.startsWith("<workspace>")).toBe(true);
    expect(result.endsWith("</workspace>")).toBe(true);
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

  test("renders attachment path when provided", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["src"],
      files: ["package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot, {
      conversationAttachmentsPath:
        "conversations/2026-03-19T12-00-00.000Z_conv-1/attachments/",
    });

    expect(result).toContain(
      "Current conversation attachments: conversations/2026-03-19T12-00-00.000Z_conv-1/attachments/",
    );
    expect(result).not.toContain("Current conversation folder");
  });

  test("prefers client-reported host env over daemon os.homedir()", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["src"],
      files: ["package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot, {
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });

    expect(result).toContain("Host home directory: /Users/alice");
    expect(result).toContain("Host username: alice");
    // Fallback values must NOT appear when client values are provided.
    expect(result).not.toContain(`Host home directory: ${homedir()}`);
    expect(result).not.toContain(`Host username: ${userInfo().username}`);
  });

  test("falls back to daemon os info when host env options omitted", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["src"],
      files: ["package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot, {});

    expect(result).toContain(`Host home directory: ${homedir()}`);
    expect(result).toContain(`Host username: ${userInfo().username}`);
  });

  test("falls back to daemon os info when host env options are undefined", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["src"],
      files: ["package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot, {
      hostHomeDir: undefined,
      hostUsername: undefined,
    });

    expect(result).toContain(`Host home directory: ${homedir()}`);
    expect(result).toContain(`Host username: ${userInfo().username}`);
  });

  test("uses client home dir but falls back to os username when only home is provided", () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: "/sandbox",
      directories: ["src"],
      files: ["package.json"],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot, {
      hostHomeDir: "/Users/alice",
    });

    expect(result).toContain("Host home directory: /Users/alice");
    expect(result).toContain(`Host username: ${userInfo().username}`);
  });
});
