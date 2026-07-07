import { describe, expect, test } from "bun:test";

import { resolveExecutionTarget } from "./execution-target.js";

describe("resolveExecutionTarget", () => {
  test("honors an explicit manifest target over the name heuristic", () => {
    // A host_ name whose manifest declares sandbox stays sandbox…
    expect(
      resolveExecutionTarget({
        name: "host_skill_sandboxed",
        executionTarget: "sandbox",
      }),
    ).toBe("sandbox");
    // …and a non-prefixed name whose manifest declares host runs on host.
    expect(
      resolveExecutionTarget({
        name: "skill_host_tool",
        executionTarget: "host",
      }),
    ).toBe("host");
  });

  test("falls back to the name heuristic when no manifest target is set", () => {
    expect(resolveExecutionTarget({ name: "host_bash" })).toBe("host");
    expect(resolveExecutionTarget({ name: "computer_use_click" })).toBe("host");
  });

  test("defaults to sandbox for an unknown, non-host name", () => {
    expect(resolveExecutionTarget({ name: "file_read" })).toBe("sandbox");
  });
});
