import { describe, expect, test } from "bun:test";

import { deriveStepLabel } from "@/domains/chat/components/tool-progress-card/derive-step-label";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/**
 * Builds a minimal `ChatMessageToolCall` fixture for testing `deriveStepLabel`.
 * Only the fields the function actually reads (`name`, `input`) need
 * meaningful values; the rest are filled with safe defaults so the inline
 * fixtures stay readable.
 */
function buildToolCall(
  overrides: Partial<ChatMessageToolCall> & Pick<ChatMessageToolCall, "name">,
): ChatMessageToolCall {
  return {
    id: "tc-test",
    input: {},
    ...overrides,
  };
}

describe("deriveStepLabel", () => {
  test("bash → Working with truncated command and code icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "bash",
        input: { command: "echo hello world" },
      }),
    );
    expect(result).toEqual({
      title: "Working",
      info: "echo hello world",
      activity: "",
      iconName: "code",
    });
  });

  test("bash truncates commands longer than 80 chars with an ellipsis", () => {
    const longCommand = "x".repeat(120);
    const result = deriveStepLabel(
      buildToolCall({
        name: "bash",
        input: { command: longCommand },
      }),
    );
    expect(result.iconName).toBe("code");
    expect(result.title).toBe("Working");
    expect(result.info.length).toBe(80);
    expect(result.info.endsWith("…")).toBe(true);
  });

  test("str_replace_editor view → Reading with basename and file icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "str_replace_editor",
        input: { command: "view", path: "/repo/apps/web/src/index.ts" },
      }),
    );
    expect(result).toEqual({
      title: "Reading",
      info: "index.ts",
      activity: "",
      iconName: "file",
    });
  });

  test("text_editor view → Reading branch matches str_replace_editor", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "text_editor",
        input: { command: "view", path: "/tmp/foo/bar.md" },
      }),
    );
    expect(result).toEqual({
      title: "Reading",
      info: "bar.md",
      activity: "",
      iconName: "file",
    });
  });

  test("str_replace_editor create → Editing with pen icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "str_replace_editor",
        input: { command: "create", path: "/repo/new-file.tsx" },
      }),
    );
    expect(result).toEqual({
      title: "Editing",
      info: "new-file.tsx",
      activity: "",
      iconName: "pen",
    });
  });

  test("str_replace_editor str_replace → Editing with pen icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "str_replace_editor",
        input: { command: "str_replace", path: "/repo/src/foo/bar.ts" },
      }),
    );
    expect(result).toEqual({
      title: "Editing",
      info: "bar.ts",
      activity: "",
      iconName: "pen",
    });
  });

  test("computer → Using computer with action name and monitor icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "computer",
        input: { action: "screenshot" },
      }),
    );
    expect(result).toEqual({
      title: "Using computer",
      info: "screenshot",
      activity: "",
      iconName: "monitor",
    });
  });

  test("mcp__<server>__<method> → Using <server> with method as info", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "mcp__stripe__create_payment_link",
        input: {},
      }),
    );
    expect(result).toEqual({
      title: "Using stripe",
      info: "create_payment_link",
      activity: "",
      iconName: "plug",
    });
  });

  test("skill → Using a skill with skill name and sparkle icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "skill",
        input: { skill: "code-review" },
      }),
    );
    expect(result).toEqual({
      title: "Using a skill",
      info: "code-review",
      activity: "",
      iconName: "sparkle",
    });
  });

  test("skill_execute → Using a skill branch", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "skill_execute",
        input: { name: "deep-research" },
      }),
    );
    expect(result).toEqual({
      title: "Using a skill",
      info: "deep-research",
      activity: "",
      iconName: "sparkle",
    });
  });

  test("subagent_spawn → Spawning subagent with label and user-plus icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "subagent_spawn",
        input: { label: "Investigate flaky test" },
      }),
    );
    expect(result).toEqual({
      title: "Spawning subagent",
      info: "Investigate flaky test",
      activity: "",
      iconName: "user-plus",
    });
  });

  test("subagent_spawn falls back to objective when label is missing", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "subagent_spawn",
        input: { objective: "Audit auth flow" },
      }),
    );
    expect(result).toEqual({
      title: "Spawning subagent",
      info: "Audit auth flow",
      activity: "",
      iconName: "user-plus",
    });
  });

  test("unknown tool name → Running <humanized> fallback with bolt icon", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "some_unknown_tool",
        input: { whatever: "ignored" },
      }),
    );
    expect(result).toEqual({
      title: "Running Some Unknown Tool",
      info: "",
      activity: "",
      iconName: "bolt",
    });
  });

  test("subagent_spawn surfaces input.activity while title stays stable", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "subagent_spawn",
        input: {
          label: "research-toronto",
          activity: "Spawning subagent to research Toronto's location in Canada",
        },
      }),
    );
    expect(result.title).toBe("Spawning subagent");
    expect(result.activity).toBe(
      "Spawning subagent to research Toronto's location in Canada",
    );
  });

  test("skill_load falls back to input.reason when activity is absent", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "skill_load",
        input: { name: "deep-research", reason: "Loading research playbook" },
      }),
    );
    expect(result.activity).toBe("Loading research playbook");
  });

  test("no activity or reason → activity is the empty string", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "bash",
        input: { command: "ls" },
      }),
    );
    expect(result.activity).toBe("");
  });

  test("skill_execute wrapper preserves outer activity through inner-tool recursion", () => {
    const result = deriveStepLabel(
      buildToolCall({
        name: "skill_execute",
        input: {
          tool: "bash",
          input: { command: "echo hi", activity: "inner activity" },
          activity: "outer activity wins",
        },
      }),
    );
    // Inner tool drives title/info/iconName; outer activity overrides inner.
    expect(result.title).toBe("Working");
    expect(result.info).toBe("echo hi");
    expect(result.iconName).toBe("code");
    expect(result.activity).toBe("outer activity wins");
  });
});
