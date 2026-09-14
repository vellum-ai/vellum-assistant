import { describe, expect, test } from "bun:test";

import {
  ACTIVITY_KEYS,
  COMMAND_KEYS,
  FILE_PATH_KEYS,
  readToolInputString,
} from "@/domains/chat/utils/tool-input";

describe("readToolInputString", () => {
  test("returns the first key that is set", () => {
    expect(readToolInputString({ path: "a.ts" }, ...FILE_PATH_KEYS)).toBe(
      "a.ts",
    );
    expect(readToolInputString({ file_path: "b.ts" }, ...FILE_PATH_KEYS)).toBe(
      "b.ts",
    );
    expect(readToolInputString({ filePath: "c.ts" }, ...FILE_PATH_KEYS)).toBe(
      "c.ts",
    );
  });

  test("skips a blank earlier key rather than letting it win", () => {
    // Why this is not a `??` chain: an empty string is present, so `??` would
    // return it and hide the spelling that actually carries the value.
    expect(
      readToolInputString({ command: "", cmd: "ls" }, ...COMMAND_KEYS),
    ).toBe("ls");
    expect(
      readToolInputString({ activity: "   ", reason: "why" }, ...ACTIVITY_KEYS),
    ).toBe("why");
  });

  test("skips a non-string earlier key rather than stopping at it", () => {
    expect(
      readToolInputString({ command: 42, cmd: "ls" }, ...COMMAND_KEYS),
    ).toBe("ls");
  });

  test("trims, and treats whitespace-only as absent", () => {
    expect(readToolInputString({ path: "  a.ts  " }, "path")).toBe("a.ts");
    expect(readToolInputString({ path: "   " }, "path")).toBe("");
  });

  test("returns an empty string when no key is set", () => {
    expect(readToolInputString({}, ...FILE_PATH_KEYS)).toBe("");
    expect(readToolInputString({ other: "x" }, ...COMMAND_KEYS)).toBe("");
  });
});
