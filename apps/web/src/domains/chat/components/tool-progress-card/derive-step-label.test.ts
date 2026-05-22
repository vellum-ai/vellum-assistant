import { describe, expect, test } from "bun:test";

import { deriveStepLabel } from "@/domains/chat/components/tool-progress-card/derive-step-label.js";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";

/**
 * Builds a minimal `ChatMessageToolCall` fixture for testing `deriveStepLabel`.
 * Only the fields the function actually reads (`toolName`, `input`) need
 * meaningful values; the rest are filled with safe defaults so the inline
 * fixtures stay readable.
 */
function buildToolCall(
  overrides: Partial<ChatMessageToolCall> & Pick<ChatMessageToolCall, "toolName">,
): ChatMessageToolCall {
  return {
    id: "tc-test",
    input: {},
    status: "running",
    ...overrides,
  };
}

describe("deriveStepLabel", () => {
  test("bash → Working (bash) with truncated command and code icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "bash",
        input: { command: "echo hello world" },
      }),
    );
    expect(result).toEqual({
      title: "Working (bash)",
      info: "echo hello world",
      iconName: "code",
    });
  });

  test("bash truncates commands longer than 80 chars with an ellipsis", () => {
    const longCommand = "x".repeat(120);
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "bash",
        input: { command: longCommand },
      }),
    );
    expect(result.iconName).toBe("code");
    expect(result.title).toBe("Working (bash)");
    expect(result.info.length).toBe(80);
    expect(result.info.endsWith("…")).toBe(true);
  });

  test("str_replace_editor view → Reading with basename and file icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "str_replace_editor",
        input: { command: "view", path: "/repo/apps/web/src/index.ts" },
      }),
    );
    expect(result).toEqual({
      title: "Reading",
      info: "index.ts",
      iconName: "file",
    });
  });

  test("text_editor view → Reading branch matches str_replace_editor", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "text_editor",
        input: { command: "view", path: "/tmp/foo/bar.md" },
      }),
    );
    expect(result).toEqual({
      title: "Reading",
      info: "bar.md",
      iconName: "file",
    });
  });

  test("str_replace_editor create → Editing with pen icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "str_replace_editor",
        input: { command: "create", path: "/repo/new-file.tsx" },
      }),
    );
    expect(result).toEqual({
      title: "Editing",
      info: "new-file.tsx",
      iconName: "pen",
    });
  });

  test("str_replace_editor str_replace → Editing with pen icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "str_replace_editor",
        input: { command: "str_replace", path: "/repo/src/foo/bar.ts" },
      }),
    );
    expect(result).toEqual({
      title: "Editing",
      info: "bar.ts",
      iconName: "pen",
    });
  });

  test("computer → Using computer with action name and monitor icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "computer",
        input: { action: "screenshot" },
      }),
    );
    expect(result).toEqual({
      title: "Using computer",
      info: "screenshot",
      iconName: "monitor",
    });
  });

  test("mcp__<server>__<method> → Using <server> with method as info", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "mcp__stripe__create_payment_link",
        input: {},
      }),
    );
    expect(result).toEqual({
      title: "Using stripe",
      info: "create_payment_link",
      iconName: "plug",
    });
  });

  test("skill → Using a skill with skill name and sparkle icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "skill",
        input: { skill: "code-review" },
      }),
    );
    expect(result).toEqual({
      title: "Using a skill",
      info: "code-review",
      iconName: "sparkle",
    });
  });

  test("skill_execute → Using a skill branch", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "skill_execute",
        input: { name: "deep-research" },
      }),
    );
    expect(result).toEqual({
      title: "Using a skill",
      info: "deep-research",
      iconName: "sparkle",
    });
  });

  test("subagent_spawn → Spawning subagent with label and user-plus icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "subagent_spawn",
        input: { label: "Investigate flaky test" },
      }),
    );
    expect(result).toEqual({
      title: "Spawning subagent",
      info: "Investigate flaky test",
      iconName: "user-plus",
    });
  });

  test("subagent_spawn falls back to objective when label is missing", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "subagent_spawn",
        input: { objective: "Audit auth flow" },
      }),
    );
    expect(result).toEqual({
      title: "Spawning subagent",
      info: "Audit auth flow",
      iconName: "user-plus",
    });
  });

  test("unknown tool name → Running <humanized> fallback with bolt icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        toolName: "some_unknown_tool",
        input: { whatever: "ignored" },
      }),
    );
    expect(result).toEqual({
      title: "Running Some Unknown Tool",
      info: "",
      iconName: "bolt",
    });
  });
});
