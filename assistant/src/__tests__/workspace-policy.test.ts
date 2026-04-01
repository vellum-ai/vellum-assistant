import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  isPathWithinWorkspaceRoot,
  isWorkspaceScopedInvocation,
} from "../permissions/workspace-policy.js";

// ---------------------------------------------------------------------------
// Temp directory scaffold for symlink / path-containment tests
// ---------------------------------------------------------------------------

let testDir: string;
let workspaceRoot: string;
let outsideDir: string;
let symlinkInside: string;
let symlinkToOutside: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "ws-policy-test-"));
  workspaceRoot = join(testDir, "workspace");
  outsideDir = join(testDir, "outside");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  // Symlink inside workspace pointing to another directory inside workspace
  symlinkInside = join(workspaceRoot, "link-to-src");
  symlinkSync(join(workspaceRoot, "src"), symlinkInside);

  // Symlink inside workspace pointing outside the workspace
  symlinkToOutside = join(workspaceRoot, "link-to-outside");
  symlinkSync(outsideDir, symlinkToOutside);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isPathWithinWorkspaceRoot
// ---------------------------------------------------------------------------

describe("isPathWithinWorkspaceRoot", () => {
  test("returns true for a file directly inside the workspace", () => {
    expect(
      isPathWithinWorkspaceRoot(join(workspaceRoot, "file.txt"), workspaceRoot),
    ).toBe(true);
  });

  test("returns true for a file in a subdirectory", () => {
    expect(
      isPathWithinWorkspaceRoot(
        join(workspaceRoot, "src", "index.ts"),
        workspaceRoot,
      ),
    ).toBe(true);
  });

  test("returns true for the workspace root itself", () => {
    expect(isPathWithinWorkspaceRoot(workspaceRoot, workspaceRoot)).toBe(true);
  });

  test("returns false for a path outside the workspace", () => {
    expect(isPathWithinWorkspaceRoot(outsideDir, workspaceRoot)).toBe(false);
  });

  test("returns false for parent traversal escaping the workspace", () => {
    const escapedPath = join(workspaceRoot, "..", "outside", "secret.txt");
    expect(isPathWithinWorkspaceRoot(escapedPath, workspaceRoot)).toBe(false);
  });

  test("returns true for a symlink that resolves inside the workspace", () => {
    expect(isPathWithinWorkspaceRoot(symlinkInside, workspaceRoot)).toBe(true);
  });

  test("returns false for a symlink that resolves outside the workspace", () => {
    expect(isPathWithinWorkspaceRoot(symlinkToOutside, workspaceRoot)).toBe(
      false,
    );
  });

  test("returns false for empty filePath", () => {
    expect(isPathWithinWorkspaceRoot("", workspaceRoot)).toBe(false);
  });

  test("returns false for empty workspaceRoot", () => {
    expect(isPathWithinWorkspaceRoot("/some/file", "")).toBe(false);
  });

  test("returns false for both empty", () => {
    expect(isPathWithinWorkspaceRoot("", "")).toBe(false);
  });

  test("handles non-existent file paths gracefully (new file write)", () => {
    const newFile = join(workspaceRoot, "new-dir", "new-file.ts");
    expect(isPathWithinWorkspaceRoot(newFile, workspaceRoot)).toBe(true);
  });

  test("rejects path that is a prefix but not a child directory", () => {
    // e.g. /tmp/workspace-extra should NOT match /tmp/workspace
    const sibling = `${workspaceRoot}-extra`;
    mkdirSync(sibling, { recursive: true });
    expect(
      isPathWithinWorkspaceRoot(join(sibling, "file.txt"), workspaceRoot),
    ).toBe(false);
    rmSync(sibling, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// isWorkspaceScopedInvocation
// ---------------------------------------------------------------------------

describe("isWorkspaceScopedInvocation", () => {
  // ── Path-scoped tools ──────────────────────────────────────────────

  describe("file_read / file_write / file_edit", () => {
    test("returns true when file_path is inside workspace", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_read",
          { file_path: join(workspaceRoot, "foo.txt") },
          workspaceRoot,
        ),
      ).toBe(true);
    });

    test("returns true when path (alternate key) is inside workspace", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_write",
          { path: join(workspaceRoot, "bar.ts") },
          workspaceRoot,
        ),
      ).toBe(true);
    });

    test("returns false when file_path is outside workspace", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_edit",
          { file_path: "/etc/passwd" },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("returns false when file_path is missing", () => {
      expect(isWorkspaceScopedInvocation("file_read", {}, workspaceRoot)).toBe(
        false,
      );
    });

    test("returns false when file_path is not a string", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_write",
          { file_path: 123 },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("resolves relative path inside workspace against workspaceRoot", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_read",
          { path: "src/index.ts" },
          workspaceRoot,
        ),
      ).toBe(true);
    });

    test("resolves relative path with ../ that escapes workspace as outside", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_read",
          { file_path: "../outside/secret.txt" },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("absolute path inside workspace still works", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_edit",
          { file_path: join(workspaceRoot, "src", "main.ts") },
          workspaceRoot,
        ),
      ).toBe(true);
    });
  });

  // ── Bash ───────────────────────────────────────────────────────────

  describe("bash", () => {
    test("returns true (sandbox handles isolation)", () => {
      expect(
        isWorkspaceScopedInvocation(
          "bash",
          { command: "ls -la" },
          workspaceRoot,
        ),
      ).toBe(true);
    });
  });

  // ── Network tools ──────────────────────────────────────────────────

  describe("network tools", () => {
    const networkTools = [
      "web_search",
      "web_fetch",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_screenshot",
      "browser_close",
      "network_request",
    ];

    for (const tool of networkTools) {
      test(`${tool} is NOT workspace-scoped`, () => {
        expect(isWorkspaceScopedInvocation(tool, {}, workspaceRoot)).toBe(
          false,
        );
      });
    }
  });

  // ── Host tools ─────────────────────────────────────────────────────

  describe("host tools", () => {
    const hostTools = [
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "host_bash",
    ];

    for (const tool of hostTools) {
      test(`${tool} is NOT workspace-scoped`, () => {
        expect(isWorkspaceScopedInvocation(tool, {}, workspaceRoot)).toBe(
          false,
        );
      });
    }
  });

  // ── Always-scoped safe tools ───────────────────────────────────────

  describe("always-scoped tools", () => {
    const safeTools = [
      "skill_load",
      "recall",
      "ui_update",
      "ui_dismiss",
    ];

    for (const tool of safeTools) {
      test(`${tool} is workspace-scoped`, () => {
        expect(isWorkspaceScopedInvocation(tool, {}, workspaceRoot)).toBe(true);
      });
    }
  });

  // ── Unknown tools ──────────────────────────────────────────────────

  describe("unknown tools", () => {
    test("defaults to NOT workspace-scoped", () => {
      expect(
        isWorkspaceScopedInvocation("mystery_tool", {}, workspaceRoot),
      ).toBe(false);
    });
  });
});
