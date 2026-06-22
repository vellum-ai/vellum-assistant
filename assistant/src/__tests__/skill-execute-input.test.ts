import { describe, expect, test } from "bun:test";

import {
  augmentSkillExecuteError,
  recoverSkillExecuteEnvelope,
  resolveSkillExecuteInput,
} from "../tools/skills/execute.js";

/** Schema with exactly one required string field (e.g. document_update). */
const SINGLE_REQUIRED_STRING_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string" },
    mode: { type: "string", enum: ["replace", "append"] },
  },
  required: ["content"],
};

describe("resolveSkillExecuteInput", () => {
  test("returns a correctly nested object unchanged", () => {
    const input = { prompt: "a sunset", variants: 2 };
    const result = resolveSkillExecuteInput({
      tool: "media_generate_image",
      input,
      activity: "Generating image",
    });
    expect(result).toEqual(input);
  });

  test("rescues parameters spread as top-level siblings", () => {
    // Weak model put `prompt` next to `tool`/`activity` instead of under `input`.
    const result = resolveSkillExecuteInput({
      tool: "media_generate_image",
      activity: "Generating image",
      prompt: "a sunset over the ocean",
      variants: 2,
    });
    expect(result).toEqual({ prompt: "a sunset over the ocean", variants: 2 });
  });

  test("rescues siblings when input is an empty object", () => {
    // The exact shape from the room-redesign failure: `input: {}` plus the
    // real parameter placed at the top level.
    const result = resolveSkillExecuteInput({
      tool: "media_generate_image",
      input: {},
      activity: "Generating room concept image",
      prompt: "a cozy living room",
    });
    expect(result).toEqual({ prompt: "a cozy living room" });
  });

  test("parses input passed as a JSON string", () => {
    const result = resolveSkillExecuteInput({
      tool: "media_generate_image",
      input: '{"prompt":"a sunset","variants":3}',
      activity: "Generating image",
    });
    expect(result).toEqual({ prompt: "a sunset", variants: 3 });
  });

  test("non-empty nested object wins over stray siblings", () => {
    const result = resolveSkillExecuteInput({
      tool: "media_generate_image",
      input: { prompt: "the real prompt" },
      activity: "Generating image",
      prompt: "a stray sibling",
    });
    expect(result).toEqual({ prompt: "the real prompt" });
  });

  test("returns empty object when no parameters are present anywhere", () => {
    const result = resolveSkillExecuteInput({
      tool: "media_generate_image",
      input: {},
      activity: "Generating image",
    });
    expect(result).toEqual({});
  });

  test("does not treat a JSON array string as input", () => {
    // An array isn't a valid parameter map; fall through to (absent) siblings.
    const result = resolveSkillExecuteInput({
      tool: "some_tool",
      input: "[1,2,3]",
      activity: "Doing work",
    });
    expect(result).toEqual({});
  });

  test("ignores envelope keys when rescuing siblings", () => {
    const result = resolveSkillExecuteInput({
      tool: "some_tool",
      activity: "Doing work",
      foo: "bar",
    });
    expect(result).toEqual({ foo: "bar" });
  });

  test("maps a bare (non-JSON) input string to the sole required string field", () => {
    // The exact shape from the doc-writer incident: the full Markdown body
    // passed as `input` instead of `{ "content": "..." }`.
    const body = "# AI in 2026\n\nWe're halfway through the year.";
    const result = resolveSkillExecuteInput(
      { tool: "document_update", input: body, activity: "Streaming article" },
      SINGLE_REQUIRED_STRING_SCHEMA,
    );
    expect(result).toEqual({ content: body });
  });

  test("does not map a bare string without the inner schema", () => {
    const result = resolveSkillExecuteInput({
      tool: "document_update",
      input: "# AI in 2026",
      activity: "Streaming article",
    });
    expect(result).toEqual({});
  });

  test("does not map a bare string when the schema has multiple required fields", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const result = resolveSkillExecuteInput(
      { tool: "t", input: "some text", activity: "x" },
      schema,
    );
    expect(result).toEqual({});
  });

  test("does not map a bare string when the sole required field is not a string", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const result = resolveSkillExecuteInput(
      { tool: "t", input: "42", activity: "x" },
      schema,
    );
    // "42" parses as JSON but isn't an object, and the lone required field is
    // not a string — no rescue applies.
    expect(result).toEqual({});
  });

  test("a valid JSON-object string still wins over the bare-string rescue", () => {
    const result = resolveSkillExecuteInput(
      {
        tool: "document_update",
        input: '{"content":"hello","mode":"append"}',
        activity: "x",
      },
      SINGLE_REQUIRED_STRING_SCHEMA,
    );
    expect(result).toEqual({ content: "hello", mode: "append" });
  });

  test("an empty input string is not rescued (nothing to map)", () => {
    const result = resolveSkillExecuteInput(
      { tool: "document_update", input: "", activity: "x" },
      SINGLE_REQUIRED_STRING_SCHEMA,
    );
    expect(result).toEqual({});
  });
});

describe("recoverSkillExecuteEnvelope", () => {
  test("recovers a valid envelope wrapped under the _raw marker", () => {
    // MiniMax coercion marks a bare-string `input` call unparseable even though
    // the outer arguments are valid JSON.
    const raw = JSON.stringify({
      tool: "document_update",
      input: "# AI in 2026\n\nbody",
      activity: "Streaming",
    });
    const recovered = recoverSkillExecuteEnvelope({ _raw: raw });
    expect(recovered).toEqual({
      tool: "document_update",
      input: "# AI in 2026\n\nbody",
      activity: "Streaming",
    });
  });

  test("leaves a genuinely unparseable (truncated) call wrapped", () => {
    const wrapped = { _raw: '{"tool":"document_update","input":"# AI' };
    expect(recoverSkillExecuteEnvelope(wrapped)).toBe(wrapped);
  });

  test("passes a normal envelope through untouched", () => {
    const envelope = {
      tool: "document_update",
      input: { content: "hi" },
      activity: "x",
    };
    expect(recoverSkillExecuteEnvelope(envelope)).toBe(envelope);
  });

  test("end-to-end: recovered bare-string envelope resolves to content", () => {
    const body = "# Title\n\nThe full article body.";
    const raw = JSON.stringify({
      tool: "document_update",
      input: body,
      activity: "Streaming",
    });
    const envelope = recoverSkillExecuteEnvelope({ _raw: raw });
    const resolved = resolveSkillExecuteInput(
      envelope,
      SINGLE_REQUIRED_STRING_SCHEMA,
    );
    expect(resolved).toEqual({ content: body });
  });
});

describe("augmentSkillExecuteError", () => {
  test("appends envelope guidance when an empty-input call errors", () => {
    // The subagent_spawn failure: empty input, tool rejects with a field-level
    // message that says nothing about the skill_execute envelope.
    const result = augmentSkillExecuteError(
      "subagent_spawn",
      {},
      { content: 'Both "label" and "objective" are required.', isError: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Both "label" and "objective" are required.',
    );
    expect(result.content).toContain("carried no parameters");
    expect(result.content).toContain('"tool": "subagent_spawn"');
    expect(result.content).toContain("inside `input`");
    // The guidance must not condemn the JSON-encoded-string form: the resolver
    // accepts it (resolveSkillExecuteInput parses string input), and it is a
    // shape weak models successfully use. Telling them it is wrong steers them
    // toward dropping the payload entirely.
    expect(result.content).not.toContain("JSON-encoded string");
  });

  test("leaves errors untouched when parameters were resolved", () => {
    // A non-empty resolved input means the model structured the call; any error
    // is a real tool-level failure, not an envelope-shape mistake.
    const original = {
      content: "Subagent quota exceeded.",
      isError: true,
    };
    const result = augmentSkillExecuteError(
      "subagent_spawn",
      { label: "x", objective: "y" },
      original,
    );
    expect(result).toBe(original);
  });

  test("leaves successful empty-input calls untouched", () => {
    // Tools that legitimately accept no parameters (e.g. subagent_status) must
    // not have guidance appended to their successful results.
    const original = { content: "No subagents running.", isError: false };
    const result = augmentSkillExecuteError("subagent_status", {}, original);
    expect(result).toBe(original);
  });
});
