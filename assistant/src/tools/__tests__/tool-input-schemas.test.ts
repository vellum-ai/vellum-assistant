import { describe, expect, test } from "bun:test";

import { askQuestionTool } from "../ask-question/ask-question-tool.js";
import { fileEditTool } from "../filesystem/edit.js";
import { fileListTool } from "../filesystem/list.js";
import { fileReadTool } from "../filesystem/read.js";
import { fileWriteTool } from "../filesystem/write.js";
import { hostFileEditTool } from "../host-filesystem/edit.js";
import { hostFileReadTool } from "../host-filesystem/read.js";
import { hostFileWriteTool } from "../host-filesystem/write.js";
import { hostShellTool } from "../host-terminal/host-shell.js";
import { notifyParentTool } from "../subagent/notify-parent.js";
import { requestSystemPermissionTool } from "../system/request-permission.js";
import { shellTool } from "../terminal/shell.js";
import { parseToolInput, TOOL_INPUT_SCHEMAS } from "../tool-input-schemas.js";

describe("parseToolInput", () => {
  test("passes input through unchanged for a tool with no registered schema", () => {
    const input = { anything: 42, nested: { deep: true } };
    const result = parseToolInput("some_unregistered_tool", input);
    expect(result).toEqual({ ok: true, data: input });
  });

  test("rejects malformed input with a message naming the tool and field", () => {
    const result = parseToolInput("file_write", { path: 42, content: "hi" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.message).toContain('Invalid input for tool "file_write"');
    expect(result.message).toContain("path:");
    expect(result.message).toContain("retry");
  });

  test("rejects a missing required field", () => {
    const result = parseToolInput("file_write", { path: "a.txt" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.message).toContain("content");
  });

  test("accepts valid input and preserves unknown keys (injected fields)", () => {
    const result = parseToolInput("file_write", {
      path: "notes.md",
      content: "hello",
      activity: "Saving your notes",
      injected_by_harness: true,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        path: "notes.md",
        content: "hello",
        activity: "Saving your notes",
        injected_by_harness: true,
      },
    });
  });

  test("a malformed status-only activity field degrades instead of failing the call", () => {
    const result = parseToolInput("file_write", {
      path: "notes.md",
      content: "hello",
      activity: null,
    });
    expect(result).toEqual({
      ok: true,
      data: { path: "notes.md", content: "hello" },
    });
  });

  test("file_read drops malformed optional fields the tool always ignored", () => {
    const result = parseToolInput("file_read", {
      path: "notes.md",
      offset: "not-a-number",
      limit: 10,
    });
    expect(result).toEqual({
      ok: true,
      data: { path: "notes.md", limit: 10 },
    });
  });

  test("file_edit drops a malformed replace_all instead of failing", () => {
    const result = parseToolInput("file_edit", {
      path: "notes.md",
      old_string: "a",
      new_string: "b",
      replace_all: "yes",
    });
    expect(result).toEqual({
      ok: true,
      data: { path: "notes.md", old_string: "a", new_string: "b" },
    });
  });

  test("file_edit rejects an empty old_string with the explanatory message", () => {
    const result = parseToolInput("file_edit", {
      path: "notes.md",
      old_string: "",
      new_string: "b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.message).toContain("old_string must not be empty");
  });

  test("ask_question rejects an option count outside 2-4 with the field path", () => {
    const result = parseToolInput("ask_question", {
      questions: [
        {
          question: "Which one?",
          options: [{ id: "only", label: "Only" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.message).toContain("questions.0.options");
  });
});

describe("derived input_schema", () => {
  const derivedTools = [
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    fileListTool,
    askQuestionTool,
    hostFileReadTool,
    hostFileWriteTool,
    hostFileEditTool,
    shellTool,
    hostShellTool,
    requestSystemPermissionTool,
    notifyParentTool,
  ];

  test("every registered schema belongs to a tool whose input_schema is derived from it", () => {
    expect([...Object.keys(TOOL_INPUT_SCHEMAS)].sort()).toEqual(
      derivedTools.map((t) => t.name).sort(),
    );
  });

  test("derived schemas are plain tool-definition JSON schemas", () => {
    for (const tool of derivedTools) {
      const schema = tool.input_schema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      // Tool definitions carry no draft marker, and permissive
      // `additionalProperties` authoring artifacts are stripped.
      expect(schema).not.toContainKey("$schema");
      expect(JSON.stringify(schema)).not.toContain("additionalProperties");
    }
  });

  test("filesystem tools still advertise activity as required with its description", () => {
    for (const tool of [
      fileReadTool,
      fileWriteTool,
      fileEditTool,
      fileListTool,
    ]) {
      const schema = tool.input_schema as {
        properties: Record<string, { type?: string; description?: string }>;
        required: string[];
      };
      expect(schema.required).toContain("activity");
      expect(schema.required).toContain("path");
      expect(schema.properties.activity?.type).toBe("string");
      expect(schema.properties.activity?.description).toContain(
        "status update",
      );
    }
  });

  test("optional runtime-tolerant fields keep their descriptions and stay non-required", () => {
    const schema = fileReadTool.input_schema as {
      properties: Record<string, { type?: string; description?: string }>;
      required: string[];
    };
    expect(schema.properties.offset?.type).toBe("number");
    expect(schema.properties.offset?.description).toContain("1-indexed");
    expect(schema.required).not.toContain("offset");
    expect(schema.required).not.toContain("limit");
  });
});
