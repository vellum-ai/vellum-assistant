/**
 * Tests for the periodic zombie sampler.
 *
 * We can't reliably synthesise a zombie inside the test runner —
 * Node's `child_process.spawn` and Bun's spawn both install SIGCHLD
 * handlers that auto-reap children, so any process we launch from
 * this test is reaped before it can be observed in state `Z`. Instead
 * we cover:
 *
 *   1. `parseProcStat()` against synthetic stat strings — the parser
 *      is the part most likely to drift if a future bun/node version
 *      reshapes the proc layout.
 *   2. `sampleZombies()` against `/proc/<our-own-pid>` to confirm the
 *      ppid filter rejects non-matches (we ourselves are not a zombie
 *      and our ppid != our pid).
 *   3. Sampler lifecycle: no-op on non-Linux, idempotent start,
 *      `stopZombieSampler` clears the interval.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { isLinux } from "../../util/platform.js";

interface LogCall {
  level: "info" | "warn" | "debug" | "error";
  fields: Record<string, unknown>;
  msg: string;
}
const logCalls: LogCall[] = [];

function recordLog(level: LogCall["level"]) {
  return (fields: Record<string, unknown> | string, msg?: string) => {
    if (typeof fields === "string") {
      logCalls.push({ level, fields: {}, msg: fields });
    } else {
      logCalls.push({ level, fields, msg: msg ?? "" });
    }
  };
}

mock.module("../../util/logger.js", () => ({
  getLogger: () => ({
    info: recordLog("info"),
    warn: recordLog("warn"),
    debug: recordLog("debug"),
    error: recordLog("error"),
  }),
}));

describe("parseProcStat", () => {
  test("parses a normal stat line", async () => {
    const { parseProcStat } = await import("../zombie-process-sampler.js");
    // Real /proc/1/stat format (truncated for brevity).
    const stat =
      "1234 (bun) S 1 1234 1234 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0";
    const parsed = parseProcStat(stat);
    expect(parsed).not.toBeNull();
    expect(parsed!.state).toBe("S");
    expect(parsed!.ppid).toBe(1);
    expect(parsed!.comm).toBe("bun");
  });

  test("parses a zombie stat line", async () => {
    const { parseProcStat } = await import("../zombie-process-sampler.js");
    const stat = "5678 (git) Z 4321 1 1 0 0 4194304 0 0 0 0 0 0";
    const parsed = parseProcStat(stat);
    expect(parsed!.state).toBe("Z");
    expect(parsed!.ppid).toBe(4321);
    expect(parsed!.comm).toBe("git");
  });

  test("comm values containing parentheses are parsed via the last `)`", async () => {
    const { parseProcStat } = await import("../zombie-process-sampler.js");
    // Linux truncates `comm` to 15 chars but the parser still has to handle
    // embedded parens correctly because /proc/<pid>/stat is the canonical
    // reading surface for this field.
    const stat = "100 (weird ((proc)) Z 99 0 0 0 0 0";
    const parsed = parseProcStat(stat);
    expect(parsed!.state).toBe("Z");
    expect(parsed!.ppid).toBe(99);
    expect(parsed!.comm).toBe("weird ((proc)");
  });

  test("comm values containing spaces are preserved", async () => {
    const { parseProcStat } = await import("../zombie-process-sampler.js");
    const stat = "200 (my proc) Z 1 0 0 0 0 0";
    const parsed = parseProcStat(stat);
    expect(parsed!.comm).toBe("my proc");
    expect(parsed!.state).toBe("Z");
    expect(parsed!.ppid).toBe(1);
  });

  test("returns null for malformed lines", async () => {
    const { parseProcStat } = await import("../zombie-process-sampler.js");
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("not a stat line")).toBeNull();
    expect(parseProcStat("123 noparens here")).toBeNull();
    expect(parseProcStat("123 (cmd)")).toBeNull(); // no state/ppid
  });
});

describe("sampleZombies", () => {
  const linuxTest = isLinux() ? test : test.skip;

  linuxTest(
    "returns 0 when no zombies are parented to a process pid",
    async () => {
      const { sampleZombies } = await import("../zombie-process-sampler.js");
      // We pick a parentPid that is extremely unlikely to be the parent
      // of any zombie on the runner: our own pid. We're not dead so we
      // can't be a zombie's parent in state Z (well — we *could* if a
      // child died and we haven't reaped, but Node always reaps, so 0).
      const sample = sampleZombies(process.pid);
      expect(sample.total).toBe(0);
      expect(Object.keys(sample.byCommand).length).toBe(0);
    },
  );

  test("returns 0 with empty byCommand on non-Linux (no /proc)", async () => {
    if (isLinux()) return;
    const { sampleZombies } = await import("../zombie-process-sampler.js");
    const sample = sampleZombies(process.pid);
    expect(sample.total).toBe(0);
    expect(Object.keys(sample.byCommand).length).toBe(0);
  });
});

describe("zombie sampler lifecycle", () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  afterEach(async () => {
    const { stopZombieSampler } = await import("../zombie-process-sampler.js");
    stopZombieSampler();
    logCalls.length = 0;
  });

  test("does not start on non-Linux platforms", async () => {
    if (isLinux()) return;
    const { startZombieSampler } = await import("../zombie-process-sampler.js");
    startZombieSampler({ intervalMs: 60_000 });
    expect(logCalls.some((c) => c.msg === "Zombie sampler started")).toBe(
      false,
    );
  });

  test("start is idempotent — second call does not double-log or double-start", async () => {
    if (!isLinux()) return;
    const { startZombieSampler } = await import("../zombie-process-sampler.js");
    startZombieSampler({ intervalMs: 60_000 });
    const firstCount = logCalls.filter(
      (c) => c.msg === "Zombie sampler started",
    ).length;
    expect(firstCount).toBe(1);
    startZombieSampler({ intervalMs: 60_000 });
    const secondCount = logCalls.filter(
      (c) => c.msg === "Zombie sampler started",
    ).length;
    expect(secondCount).toBe(1);
  });

  test("steady-state (no zombies) emits debug, not info or warn", async () => {
    if (!isLinux()) return;
    const { startZombieSampler } = await import("../zombie-process-sampler.js");
    startZombieSampler({ intervalMs: 60_000 });
    // Running daemon should have no zombies parented to itself
    // (Node auto-reaps via libuv).
    const noiseInfo = logCalls.find(
      (c) =>
        c.level === "info" &&
        c.msg.startsWith("Zombie sampler — orphan subprocesses"),
    );
    const noiseWarn = logCalls.find(
      (c) =>
        c.level === "warn" &&
        c.msg.startsWith("Zombie sampler — orphan subprocesses"),
    );
    expect(noiseInfo).toBeUndefined();
    expect(noiseWarn).toBeUndefined();
  });
});
