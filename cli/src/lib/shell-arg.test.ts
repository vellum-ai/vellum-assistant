import { describe, expect, test } from "bun:test";

import { shellArg } from "./shell-arg.js";

describe("shellArg", () => {
  test("leaves plainly inert values alone", () => {
    for (const value of ["jarvis", "assistant-1", "jarvis-2.0_beta"]) {
      expect(shellArg(value)).toBe(value);
    }
  });

  test("quotes values a shell would otherwise interpret", () => {
    // Assistant names and ids are only checked for path separators, so all of
    // these can reach a printed command.
    expect(shellArg("My Assistant")).toBe("'My Assistant'");
    expect(shellArg("Bob&Alice")).toBe("'Bob&Alice'");
    expect(shellArg("My $team")).toBe("'My $team'");
    expect(shellArg("a`whoami`")).toBe("'a`whoami`'");
  });

  test("closes, escapes, and reopens around an embedded single quote", () => {
    expect(shellArg("Bob's box")).toBe(`'Bob'\\''s box'`);
  });
});
