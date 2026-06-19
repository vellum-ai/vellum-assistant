import { describe, expect, test } from "bun:test";

import {
  augmentSkillExecuteError,
  resolveSkillExecuteInput,
} from "../tools/skills/execute.js";

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
