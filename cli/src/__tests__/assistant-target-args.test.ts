import { describe, expect, test } from "bun:test";

import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";

describe("parseAssistantTargetArg", () => {
  test("joins unquoted display-name words into one assistant target", () => {
    expect(parseAssistantTargetArg(["Example", "Assistant"])).toBe(
      "Example Assistant",
    );
  });

  test("skips boolean flags", () => {
    expect(parseAssistantTargetArg(["Example", "Assistant", "--verbose"])).toBe(
      "Example Assistant",
    );
  });

  test("skips configured flags and their values", () => {
    expect(
      parseAssistantTargetArg(
        ["--url", "http://localhost:7830", "Example", "Assistant"],
        ["--url"],
      ),
    ).toBe("Example Assistant");
  });

  test("returns undefined when no target is present", () => {
    expect(parseAssistantTargetArg(["--verbose"])).toBeUndefined();
  });
});
