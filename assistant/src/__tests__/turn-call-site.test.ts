import { describe, expect, test } from "bun:test";

import { resolveTurnCallSite } from "../daemon/turn-call-site.js";

describe("resolveTurnCallSite", () => {
  test("uses the explicit call site when one is provided", () => {
    expect(resolveTurnCallSite("heartbeatAgent", { isSubagent: false })).toBe(
      "heartbeatAgent",
    );
    expect(resolveTurnCallSite("heartbeatAgent", { isSubagent: true })).toBe(
      "heartbeatAgent",
    );
  });

  test("defaults a non-subagent conversation to mainAgent", () => {
    expect(resolveTurnCallSite(undefined, { isSubagent: false })).toBe(
      "mainAgent",
    );
  });

  test("defaults a subagent conversation to subagentSpawn", () => {
    // Turns that omit an explicit call site — queue-drained follow-ups,
    // background-command wakes — must stay tagged as subagent turns so the
    // inference config and the post-tool-use nudge gates treat them correctly.
    expect(resolveTurnCallSite(undefined, { isSubagent: true })).toBe(
      "subagentSpawn",
    );
  });
});
