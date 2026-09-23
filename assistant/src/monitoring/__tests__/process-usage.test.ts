/**
 * Tests for the per-process CPU and memory tracker, against a fixture proc
 * tree. CPU is a rate between two scans, so each test writes counters, scans,
 * advances the counters, and scans again.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readKernelPageSizeBytes } from "../proc-wait-state.js";
import { createProcessUsageTracker } from "../process-usage.js";
import { stat } from "./proc-fixtures.js";

const DAEMON = 1;
const MB_PAGES = 256; // 1 MiB in 4 KiB pages

let procRoot: string;

function writeProcess(
  pid: number,
  comm: string,
  cpuTicks: number,
  opts: { startTicks?: number; rssMb?: number; cmdline?: string[] } = {},
): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "stat"),
    stat(pid, comm, "S", 0, opts.startTicks ?? 100, {
      utime: cpuTicks,
      rssPages: (opts.rssMb ?? 10) * MB_PAGES,
    }),
  );
  writeFileSync(join(dir, "cmdline"), (opts.cmdline ?? [comm]).join("\0"));
}

beforeEach(() => {
  procRoot = mkdtempSync(join(tmpdir(), "process-usage-"));
});

afterEach(() => {
  rmSync(procRoot, { recursive: true, force: true });
});

describe("createProcessUsageTracker", () => {
  test("reports CPU as a rate between two scans, busiest first", () => {
    // GIVEN a daemon and a memory worker
    const tracker = createProcessUsageTracker({ procRoot });
    writeProcess(DAEMON, "bun", 1_000, { rssMb: 900 });
    writeProcess(20, "bun", 5_000, {
      rssMb: 1_200,
      cmdline: [
        "bun",
        "--smol",
        "run",
        "/app/src/plugins/defaults/memory/worker.ts",
      ],
    });

    // WHEN the first scan runs
    // THEN there is no rate yet
    expect(tracker.sample(0, DAEMON)).toBeNull();

    // WHEN 2s later the worker used 3 CPU-seconds and the daemon 0.1s
    writeProcess(DAEMON, "bun", 1_010, { rssMb: 900 });
    writeProcess(20, "bun", 5_300, {
      rssMb: 1_200,
      cmdline: [
        "bun",
        "--smol",
        "run",
        "/app/src/plugins/defaults/memory/worker.ts",
      ],
    });
    const usage = tracker.sample(2_000, DAEMON);

    // THEN the worker shows 150% of a core and leads the list
    expect(usage).toEqual([
      { pid: 20, name: "memory-worker", cpuPct: 150, rssMb: 1_200 },
      { pid: DAEMON, name: "daemon", cpuPct: 5, rssMb: 900 },
    ]);
  });

  test("never reports command-line arguments", () => {
    // GIVEN a process started with a secret on its command line
    const tracker = createProcessUsageTracker({ procRoot });
    const cmdline = ["bun", "run", "deploy", "--token=sk-secret"];
    writeProcess(30, "bun", 0, { cmdline });
    tracker.sample(0, DAEMON);
    writeProcess(30, "bun", 100, { cmdline });

    // WHEN it is reported
    const usage = tracker.sample(1_000, DAEMON)!;

    // THEN only the kernel comm is used
    expect(usage[0]!.name).toBe("bun");
    expect(JSON.stringify(usage)).not.toContain("secret");
  });

  test("a reused pid is not given its predecessor's counters", () => {
    // GIVEN pid 40 exits and a new process takes the pid
    const tracker = createProcessUsageTracker({ procRoot });
    writeProcess(40, "old", 9_000, { startTicks: 100 });
    tracker.sample(0, DAEMON);
    writeProcess(40, "chromium", 50, { startTicks: 500 });

    // WHEN the next scan runs
    const usage = tracker.sample(1_000, DAEMON)!;

    // THEN the new process is skipped until it has two readings
    expect(usage).toEqual([]);
  });

  test("the daemon is kept even when it is not among the busiest", () => {
    // GIVEN seven busy processes and an idle, small daemon
    const tracker = createProcessUsageTracker({ procRoot });
    writeProcess(DAEMON, "bun", 0, { rssMb: 1 });
    for (let pid = 50; pid < 57; pid++) {
      writeProcess(pid, `chrome-${pid}`, 0);
    }
    tracker.sample(0, DAEMON);
    writeProcess(DAEMON, "bun", 0, { rssMb: 1 });
    for (let pid = 50; pid < 57; pid++) {
      writeProcess(pid, `chrome-${pid}`, 100);
    }

    // WHEN the next scan runs
    const usage = tracker.sample(1_000, DAEMON)!;

    // THEN four by CPU, two by memory, plus the daemon are reported
    expect(usage).toHaveLength(7);
    expect(usage.at(-1)).toMatchObject({ name: "daemon", cpuPct: 0 });
  });

  test("scans at most once per interval and reuses the last result", () => {
    // GIVEN two completed scans
    const tracker = createProcessUsageTracker({ procRoot });
    writeProcess(DAEMON, "bun", 0);
    tracker.sample(0, DAEMON);
    writeProcess(DAEMON, "bun", 50);
    const first = tracker.sample(1_000, DAEMON);

    // WHEN a tick arrives 250ms later with new counters
    writeProcess(DAEMON, "bun", 999);
    const again = tracker.sample(1_250, DAEMON);

    // THEN the previous result is reused, not rescanned
    expect(again).toBe(first);
  });

  test("an unreadable /proc yields null", () => {
    const tracker = createProcessUsageTracker({
      procRoot: join(procRoot, "missing"),
    });
    expect(tracker.sample(0, DAEMON)).toBeNull();
    expect(tracker.sample(2_000, DAEMON)).toBeNull();
  });

  test("only allowlisted worker scripts get a worker label", () => {
    // GIVEN the real schedule worker and a user script shaped like a worker
    const tracker = createProcessUsageTracker({ procRoot });
    const schedule = ["bun", "run", "/app/assistant/src/schedule/worker.ts"];
    const lookalike = ["bun", "run", "/home/me/acme-payroll-worker.ts"];
    writeProcess(60, "bun", 0, { cmdline: schedule });
    writeProcess(61, "bun", 0, { cmdline: lookalike });
    tracker.sample(0, DAEMON);
    writeProcess(60, "bun", 20, { cmdline: schedule });
    writeProcess(61, "bun", 10, { cmdline: lookalike });

    // WHEN they are reported
    const names = tracker.sample(1_000, DAEMON)!.map((p) => p.name);

    // THEN the look-alike falls back to the kernel comm
    expect(names).toEqual(["schedule-worker", "bun"]);
  });

  test("an idle process holding the most memory is still reported", () => {
    // GIVEN six small busy processes and an idle, memory-heavy one
    const tracker = createProcessUsageTracker({ procRoot });
    for (let pid = 70; pid < 76; pid++) {
      writeProcess(pid, `busy-${pid}`, 0, { rssMb: 5 });
    }
    writeProcess(80, "qdrant", 0, { rssMb: 2_000 });
    tracker.sample(0, DAEMON);
    for (let pid = 70; pid < 76; pid++) {
      writeProcess(pid, `busy-${pid}`, 10, { rssMb: 5 });
    }
    writeProcess(80, "qdrant", 0, { rssMb: 2_000 });

    // WHEN the next scan runs
    const usage = tracker.sample(1_000, DAEMON)!;

    // THEN the memory-heavy process takes a memory slot
    expect(usage).toContainEqual({
      pid: 80,
      name: "qdrant",
      cpuPct: 0,
      rssMb: 2_000,
    });
  });

  test("converts resident pages with the kernel's page size", () => {
    // GIVEN a 64 KiB-page kernel and a process with 16384 resident pages
    const tracker = createProcessUsageTracker({
      procRoot,
      pageSizeBytes: 65_536,
    });
    writeProcess(90, "bun", 0, { rssMb: 256 }); // 256 * 256 = 65536 pages
    tracker.sample(0, DAEMON);
    writeProcess(90, "bun", 0, { rssMb: 256 });

    // WHEN it is reported
    const usage = tracker.sample(1_000, DAEMON)!;

    // THEN RSS is 16x what a 4 KiB assumption would give
    expect(usage[0]!.rssMb).toBe(4_096);
  });
});

describe("readKernelPageSizeBytes", () => {
  function writeSelf(rssKb: number, rssPages: number): void {
    const dir = join(procRoot, "self");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status"), `Name:\tbun\nVmRSS:\t  ${rssKb} kB\n`);
    writeFileSync(join(dir, "statm"), `9000 ${rssPages} 100 1 0 500 0\n`);
  }

  test("derives 64 KiB from resident kB and pages", () => {
    writeSelf(65_536, 1_024);
    expect(readKernelPageSizeBytes(procRoot)).toBe(65_536);
  });

  test("snaps a slightly skewed reading to the nearest page size", () => {
    writeSelf(4_100, 1_000);
    expect(readKernelPageSizeBytes(procRoot)).toBe(4_096);
  });

  test("falls back to 4 KiB when /proc/self is unreadable", () => {
    expect(readKernelPageSizeBytes(procRoot)).toBe(4_096);
  });
});
