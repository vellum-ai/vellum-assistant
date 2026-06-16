import { describe, expect, test } from "bun:test";

import { resolveSkillExecuteInput } from "../tools/skills/execute.js";

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
