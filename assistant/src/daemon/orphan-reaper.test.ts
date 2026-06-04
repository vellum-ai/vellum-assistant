/**
 * Tests for the orphan subprocess reaper.
 *
 * - `parseProcStat` must read state/ppid correctly even when the executable
 *   name (`comm`) contains spaces and parentheses.
 * - `selectReapable` must defer a zombie for one full scan interval (so libuv
 *   reaps its own tracked children first) and reap it on the next scan.
 * - An integration test makes the test process a child subreaper via
 *   `PR_SET_CHILD_SUBREAPER`, orphans a grandchild, and verifies the
 *   exported logic defers-then-reaps the real `<defunct>` entry while libuv
 *   independently reaps the directly-spawned (tracked) child.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { afterAll, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

const { parseProcStat, selectReapable } = await import("./orphan-reaper.js");
const { DaemonConfigSchema } = await import("../config/schemas/platform.js");

describe("parseProcStat", () => {
  test("parses a normal stat line", () => {
    // GIVEN a well-formed /proc/<pid>/stat line for a zombie
    const line = "1234 (bash) Z 1 1234 1234 0 -1 ...";
    // WHEN it is parsed
    const parsed = parseProcStat(line);
    // THEN comm, state, and ppid are extracted
    expect(parsed).toEqual({ comm: "bash", state: "Z", ppid: 1 });
  });

  test("handles comm containing spaces and parentheses", () => {
    // GIVEN a stat line whose comm field itself contains spaces and parens
    const line = "42 (weird (name) x) Z 1 42 42 0 -1 4194560";
    // WHEN it is parsed
    const parsed = parseProcStat(line);
    // THEN fields are read relative to the final ')', not naive splitting
    expect(parsed).toEqual({ comm: "weird (name) x", state: "Z", ppid: 1 });
  });

  test("reads a non-zombie running state", () => {
    // GIVEN a running (non-zombie) process line
    const line = "77 (node) R 12 77 77";
    // WHEN it is parsed
    const parsed = parseProcStat(line);
    // THEN the running state and parent pid are reported
    expect(parsed?.state).toBe("R");
    expect(parsed?.ppid).toBe(12);
  });

  test("returns null for malformed lines", () => {
    // GIVEN malformed or truncated stat content
    // WHEN each is parsed
    // THEN null is returned rather than a bogus record
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("no parens here")).toBeNull();
    expect(parseProcStat("123 (proc)")).toBeNull();
  });
});

describe("selectReapable", () => {
  test("defers a newly-seen zombie for one interval", () => {
    // GIVEN zombies never seen on a previous scan
    // WHEN deciding what to reap with an empty seen set
    const { reap, nextSeen } = selectReapable([100, 101], new Set());
    // THEN nothing is reaped yet, but both are carried into the next scan
    expect(reap).toEqual([]);
    expect([...nextSeen].sort()).toEqual([100, 101]);
  });

  test("reaps a zombie that survived the previous scan", () => {
    // GIVEN pid 100 was already seen on the prior scan and 101 is new
    // WHEN deciding what to reap
    const { reap } = selectReapable([100, 101], new Set([100]));
    // THEN only the survivor (100) is reaped; the newcomer is deferred
    expect(reap).toEqual([100]);
  });

  test("drops PIDs that have disappeared from the next seen set", () => {
    // GIVEN pid 100 was seen before but is gone now
    // WHEN computing the next seen set
    const { nextSeen } = selectReapable([101], new Set([100, 101]));
    // THEN only currently-present pids are retained
    expect([...nextSeen]).toEqual([101]);
  });
});

describe("daemon.reapOrphanedSubprocesses gate", () => {
  test("defaults to off so the reaper is opt-in", () => {
    // GIVEN a daemon config with the reaper flag unspecified
    // WHEN it is parsed with schema defaults
    const parsed = DaemonConfigSchema.parse({});
    // THEN the reaper is disabled unless explicitly turned on
    expect(parsed.reapOrphanedSubprocesses).toBe(false);
  });

  test("honors an explicit opt-in", () => {
    // GIVEN a daemon config that explicitly enables the reaper
    // WHEN it is parsed
    const parsed = DaemonConfigSchema.parse({ reapOrphanedSubprocesses: true });
    // THEN the flag is respected
    expect(parsed.reapOrphanedSubprocesses).toBe(true);
  });
});

// ── Integration: real reparented orphan on Linux ────────────────────────────
const itLinux = process.platform === "linux" ? test : test.skip;

// Bind libc only on Linux — "libc.so.6" does not exist on macOS, so binding it
// unconditionally would throw at import and break the pure-function tests too.
const lib =
  process.platform === "linux"
    ? dlopen("libc.so.6", {
        waitpid: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        prctl: {
          args: [
            FFIType.i32,
            FFIType.u64,
            FFIType.u64,
            FFIType.u64,
            FFIType.u64,
          ],
          returns: FFIType.i32,
        },
      })
    : null;
const WNOHANG = 1;
const PR_SET_CHILD_SUBREAPER = 36;
const statusBuf = new Int32Array(1);

function zombieChildPids(): number[] {
  const self = process.pid;
  const out: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      continue;
    }
    const parsed = parseProcStat(stat);
    if (parsed && parsed.state === "Z" && parsed.ppid === self) out.push(pid);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(() => {
  if (!lib) return;
  // Reap anything still lingering so the test process leaves no zombies.
  for (const pid of zombieChildPids())
    lib.symbols.waitpid(pid, ptr(statusBuf), WNOHANG);
});

itLinux(
  "defers then reaps a reparented orphan while libuv reaps the tracked child",
  async () => {
    if (!lib) return;
    // GIVEN this process is a child subreaper, so orphaned grandchildren
    // reparent here exactly as they reparent to a PID-1 daemon
    expect(lib.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n)).toBe(0);

    // AND a libuv-tracked child (A) that detaches a grandchild (B) into its
    // own session and exits immediately; B reparents to us and, once it
    // exits, becomes a zombie with our pid as its parent
    let trackedChildExited = false;
    const a = spawn("bash", ["-c", "setsid -f sleep 0.4; exit 0"], {
      stdio: "ignore",
    });
    a.on("exit", () => {
      trackedChildExited = true;
    });

    // AND we wait for that orphan to surface as our zombie child
    let zombies: number[] = [];
    for (let i = 0; i < 40 && zombies.length === 0; i++) {
      await sleep(50);
      zombies = zombieChildPids();
    }
    expect(zombies.length).toBeGreaterThan(0);
    expect(trackedChildExited).toBe(true); // libuv reaped A independently

    // WHEN we run the deferred-reap algorithm across two scans
    // (scan #1 is the grace pass, scan #2 reaps the survivor)
    const scan1 = selectReapable(zombieChildPids(), new Set<number>());
    const scan2 = selectReapable(zombieChildPids(), scan1.nextSeen);
    let reaped = 0;
    for (const pid of scan2.reap) {
      if (lib.symbols.waitpid(pid, ptr(statusBuf), WNOHANG) > 0) reaped++;
    }
    await sleep(50);

    // THEN nothing is reaped on the grace pass, the survivor is reaped on the
    // second pass, and no defunct child remains
    expect(scan1.reap).toEqual([]);
    expect(scan2.reap.length).toBeGreaterThan(0);
    expect(reaped).toBeGreaterThan(0);
    expect(zombieChildPids()).toEqual([]);
  },
);
