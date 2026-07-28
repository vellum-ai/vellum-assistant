/**
 * Tests for hallucinated-tool-name handling:
 *
 * - `resolveToolInvocationAlias` — rewrites commonly invented names
 *   (`read_file`, `shell`, `list_files`, …) to the canonical tool, only when
 *   the canonical tool is active and the requested name is not, translating
 *   the arg-key convention each alias is typically called with.
 * - `suggestToolName` — conservative `Did you mean "…"?` candidate for the
 *   Unknown-tool error: token permutations and tiny typos only, never a
 *   semantically different tool.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveToolInvocationAlias,
  suggestToolName,
} from "../tools/tool-name-aliases.js";

const ACTIVE = new Set([
  "bash",
  "file_read",
  "file_list",
  "web_search",
  "app_create",
]);

describe("resolveToolInvocationAlias", () => {
  test.each([
    ["read_file", "file_read"],
    ["read", "file_read"],
    ["cat", "file_read"],
    ["fs_read", "file_read"],
    ["workspace_read", "file_read"],
    ["list_files", "file_list"],
    ["list_directory", "file_list"],
    ["shell", "bash"],
    ["exec", "bash"],
  ])(
    "rewrites %s to %s when the canonical tool is active",
    (alias, canonical) => {
      const resolved = resolveToolInvocationAlias(alias, {}, ACTIVE);
      expect(resolved.name).toBe(canonical);
    },
  );

  test("translates the alias arg-key convention to the canonical schema", () => {
    expect(
      resolveToolInvocationAlias("read_file", { file_path: "/tmp/x" }, ACTIVE)
        .input,
    ).toEqual({ path: "/tmp/x" });
    expect(
      resolveToolInvocationAlias("list_files", { directory: "/tmp" }, ACTIVE)
        .input,
    ).toEqual({ path: "/tmp" });
    expect(
      resolveToolInvocationAlias("shell", { cmd: "ls" }, ACTIVE).input,
    ).toEqual({ command: "ls" });
  });

  test("keeps input keys that already match the canonical schema", () => {
    expect(
      resolveToolInvocationAlias(
        "read_file",
        { path: "/tmp/x", limit: 5 },
        ACTIVE,
      ).input,
    ).toEqual({ path: "/tmp/x", limit: 5 });
  });

  test("does not rewrite when the requested name is itself active", () => {
    const active = new Set(["read", "file_read"]);
    const resolved = resolveToolInvocationAlias("read", { path: "x" }, active);
    expect(resolved.name).toBe("read");
  });

  test("does not rewrite when the canonical tool is not active", () => {
    const resolved = resolveToolInvocationAlias(
      "read_file",
      { path: "x" },
      new Set(["web_search"]),
    );
    expect(resolved.name).toBe("read_file");
  });
});

describe("suggestToolName", () => {
  test("suggests the token permutation of a real tool", () => {
    // Reachable when the alias table cannot rewrite (canonical inactive) or
    // for permutations the table does not carry.
    expect(suggestToolName("search_web", ACTIVE)).toBe("web_search");
  });

  test("suggests for a small typo", () => {
    expect(suggestToolName("bassh", ACTIVE)).toBe("bash");
    expect(suggestToolName("file_reed", ACTIVE)).toBe("file_read");
  });

  test("never suggests a semantically different tool", () => {
    // task_create is 3 edits from app_create — close enough to fool a loose
    // threshold, far enough that the suggestion would misdirect.
    expect(suggestToolName("task_create", ACTIVE)).toBeUndefined();
    expect(suggestToolName("glob", ACTIVE)).toBeUndefined();
    expect(suggestToolName("notifications_send", ACTIVE)).toBeUndefined();
  });

  test("is deterministic on ties", () => {
    expect(suggestToolName("bath", ["bash", "bat"])).toBe("bash");
    expect(suggestToolName("bath", ["bat", "bash"])).toBe("bash");
  });
});
