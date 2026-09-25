import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { setOomScoreAdj, withOomScoreAdj } from "../oom-priority.js";

function fakeProc(pid: number): string {
  const procRoot = mkdtempSync(join(tmpdir(), "oom-priority-"));
  mkdirSync(join(procRoot, String(pid)));
  return procRoot;
}

describe("setOomScoreAdj", () => {
  test("writes the value for a pid on Linux", () => {
    const procRoot = fakeProc(42);
    expect(setOomScoreAdj(1000, 42, { procRoot, platform: "linux" })).toBe(
      true,
    );
    expect(readFileSync(join(procRoot, "42", "oom_score_adj"), "utf-8")).toBe(
      "1000",
    );
  });

  test("is a no-op off Linux", () => {
    const procRoot = fakeProc(42);
    expect(setOomScoreAdj(1000, 42, { procRoot, platform: "darwin" })).toBe(
      false,
    );
  });

  test("reports failure for a pid that is gone", () => {
    const procRoot = fakeProc(42);
    expect(setOomScoreAdj(0, 43, { procRoot, platform: "linux" })).toBe(false);
  });
});

describe("withOomScoreAdj", () => {
  test("execs the command through a shell that raises its own score on Linux", () => {
    expect(withOomScoreAdj(["chrome", "--flag"], 1000, "linux")).toEqual([
      "sh",
      "-c",
      'echo 1000 2>/dev/null >/proc/self/oom_score_adj; exec "$0" "$@"',
      "chrome",
      "--flag",
    ]);
  });

  test("returns the command unchanged off Linux", () => {
    expect(withOomScoreAdj(["chrome", "--flag"], 1000, "darwin")).toEqual([
      "chrome",
      "--flag",
    ]);
  });
});
