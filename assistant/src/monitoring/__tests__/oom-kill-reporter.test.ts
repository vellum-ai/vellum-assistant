import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createOomKillReporter,
  type KernelLogEntry,
  oomKillsFromEntries,
  parseDmesgJson,
  parseDmesgText,
} from "../oom-kill-reporter.js";
import type { ResourceSample } from "../resource-sample-types.js";

const TOOL_KILL =
  "Memory cgroup out of memory: Killed process 4242 (python3) total-vm:1263184kB, anon-rss:409600kB, file-rss:1024kB, shmem-rss:0kB, UID:0 pgtables:900kB oom_score_adj:1000";
const DAEMON_KILL =
  "Memory cgroup out of memory: Killed process 1 (bun) total-vm:3000000kB, anon-rss:2000000kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:5000kB oom_score_adj:-700";
const LEGACY_KILL =
  "Out of memory: Killed process 77 (node) total-vm:500000kB, anon-rss:300000kB, file-rss:0kB, shmem-rss:0kB";
const NOISE = [
  "bun invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=-700",
  "oom_reaper: reaped process 4242 (python3), now anon-rss:0kB, file-rss:0kB, shmem-rss:0kB",
];

const entry = (time: number, msg: string): KernelLogEntry => ({ time, msg });

function sample(
  oomKillDelta: number | null,
  countersAvailable = true,
): ResourceSample {
  const events = { low: 0, high: 0, max: 0, oom: 0, oomKill: 0 };
  return {
    ts: 0,
    memory: {
      currentBytes: 3_000_000_000,
      limitBytes: 3_221_225_472,
      peakBytes: 3_221_000_000,
      ratio: 0.93,
    },
    memoryStat: null,
    reclaim: null,
    cpu: null,
    events: countersAvailable ? events : null,
    deltas:
      oomKillDelta == null
        ? null
        : {
            events: { ...events, oomKill: oomKillDelta },
            reclaim: null,
            cpu: null,
          },
    disk: null,
    activeConversations: null,
  };
}

describe("kernel log parsing", () => {
  test("parses dmesg --json and plain dmesg into the same entries", () => {
    const json = `{"dmesg":[{"pri":3,"time":  44170.542000,"msg":${JSON.stringify(TOOL_KILL)}},{"pri":6,"time":44171.0,"msg":"x"}]}`;
    const text = `[44170.542000] ${TOOL_KILL}\n[   44171.000000] x\n`;
    expect(parseDmesgJson(json)).toEqual(parseDmesgText(text));
    expect(parseDmesgJson("not json")).toBeNull();
  });

  test("extracts victims, sizes and oom_score_adj, oldest first, ignoring noise", () => {
    const kills = oomKillsFromEntries([
      entry(30, NOISE[0]),
      entry(50, LEGACY_KILL),
      entry(31, TOOL_KILL),
      entry(32, NOISE[1]),
    ]);
    expect(kills).toEqual([
      {
        time: 31,
        pid: 4242,
        comm: "python3",
        oomScoreAdj: 1000,
        anonRssKb: 409600,
        totalVmKb: 1263184,
      },
      {
        time: 50,
        pid: 77,
        comm: "node",
        oomScoreAdj: null,
        anonRssKb: 300000,
        totalVmKb: 500000,
      },
    ]);
  });
});

describe("createOomKillReporter", () => {
  let dir: string;
  let recorded: Array<{ value?: number | null; detail?: unknown }>;
  let reads: number;
  let recordOk: boolean;
  let consent: boolean | null;
  let killCounter: number | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oom-kill-reporter-"));
    recorded = [];
    reads = 0;
    recordOk = true;
    consent = true;
    killCounter = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reporter(
    log: () => KernelLogEntry[] | null,
    bootId: string | null = "boot-a",
  ) {
    return createOomKillReporter({
      readKernelLog: async () => {
        reads++;
        return log();
      },
      readBootId: () => bootId,
      readKillCounter: () => killCounter,
      shareAnalytics: () => consent,
      cursorPath: join(dir, "cursor.json"),
      record: (record) => {
        if (!recordOk) {
          return null;
        }
        recorded.push(record);
        return { id: "evt", createdAt: 0 };
      },
    });
  }

  test("attributes the oldest N new kills to a counter move of N", async () => {
    let entries: KernelLogEntry[] = [];
    const r = reporter(() => entries);
    await r.check(sample(0), 0, 1);

    // Two of ours land, then a third is logged after the counter read.
    entries = [
      entry(20, TOOL_KILL),
      entry(21, TOOL_KILL),
      entry(22, TOOL_KILL),
    ];
    killCounter = 2;
    const first = await r.check(sample(2), 1_000, 1);
    expect(first).toMatchObject({ attribution: "cgroup_counter", unnamed: 0 });
    expect(first?.victims.map((v) => v.time)).toEqual([20, 21]);

    // The next tick's counter covers the straggler.
    killCounter = 3;
    const second = await r.check(sample(1), 1_250, 1);
    expect(second?.victims.map((v) => v.time)).toEqual([22]);
    expect(recorded.map((e) => e.value)).toEqual([2, 1]);
  });

  test("names every victim of a burst that straddles ticks", async () => {
    // Replay of a real 3 GiB run: the log ran ahead of the sampler's counter
    // on every tick, and the old newest-N rule dropped two victims.
    let entries: KernelLogEntry[] = [];
    const r = reporter(() => entries);
    await r.check(sample(0), 0, 1);

    const kills = [468, 472, 474, 477, 476, 467, 480, 471, 478, 473, 481].map(
      (pid, i) =>
        entry(
          216386 + i * 0.15,
          TOOL_KILL.replace("Killed process 4242", `Killed process ${pid}`),
        ),
    );
    // (visible log lines, counter after the log read) per tick
    const ticks: Array<[number, number]> = [
      [2, 1],
      [5, 4],
      [8, 7],
      [11, 10],
      [11, 11],
    ];
    const named: number[] = [];
    let t = 1_000;
    for (const [visible, counter] of ticks) {
      entries = kills.slice(0, visible);
      killCounter = counter;
      const report = await r.check(sample(1), (t += 250), 1);
      named.push(...(report?.victims.map((v) => v.pid) ?? []));
    }
    expect(named).toEqual([
      468, 472, 474, 477, 476, 467, 480, 471, 478, 473, 481,
    ]);
    expect(recorded.reduce((n, e) => n + (e.value ?? 0), 0)).toBe(11);
  });
  test("first scan reports the kill that preceded the monitor and flags the daemon by score", async () => {
    const r = reporter(() => [entry(5, DAEMON_KILL)]);
    const report = await r.check(sample(0), 0, 999);
    expect(report?.attribution).toBe("kernel_log");
    expect(recorded[0].detail).toMatchObject({
      killed_daemon: true,
      victim_count: 1,
      memory_limit_bytes: 3_221_225_472,
    });

    // A second monitor incarnation on the same kernel sees the same log: nothing new.
    expect(
      await reporter(() => [entry(5, DAEMON_KILL)]).check(sample(0), 0, 999),
    ).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  test("ignores neighbours' kills when the local counter did not move", async () => {
    let entries: KernelLogEntry[] = [];
    const r = reporter(() => entries);
    await r.check(sample(0), 0, 1);

    entries = [entry(70, LEGACY_KILL)];
    expect(await r.check(sample(0), 61_000, 1)).toBeNull();
    expect(recorded).toHaveLength(0);

    // A later local kill is still found, and the neighbour's is not swept in.
    entries = [entry(70, LEGACY_KILL), entry(80, TOOL_KILL)];
    killCounter = 1;
    const report = await r.check(sample(1), 122_000, 1);
    expect(report?.victims.map((v) => v.pid)).toEqual([4242]);
  });
  test("reports every new kill when there is no counter at all", async () => {
    killCounter = null;
    const r = reporter(() => [entry(5, TOOL_KILL)]);
    await r.check(sample(null, false), 0, 1);
    const r2 = reporter(() => [entry(5, TOOL_KILL), entry(9, LEGACY_KILL)]);
    const report = await r2.check(sample(null, false), 61_000, 1);
    expect(report?.attribution).toBe("kernel_log");
    expect(report?.victims.map((v) => v.pid)).toEqual([77]);
  });

  test("a counter move with no readable log still produces an event", async () => {
    const report = await reporter(() => null).check(sample(3), 0, 1);
    expect(report).toEqual({
      attribution: "cgroup_counter",
      victims: [],
      unnamed: 3,
    });
    expect(recorded[0]).toMatchObject({ value: 3 });
    expect(recorded[0].detail).toMatchObject({
      unnamed_victims: 3,
      killed_daemon: false,
    });
  });

  test("a rebooted kernel resets the cursor even when the boot id is unreadable", async () => {
    await reporter(() => [entry(500, TOOL_KILL)], null).check(sample(0), 0, 1);
    const report = await reporter(() => [entry(5, TOOL_KILL)], null).check(
      sample(0),
      0,
      1,
    );
    expect(report?.victims).toHaveLength(1);
    expect(recorded).toHaveLength(2);
  });

  test("keeps the cursor and retries when the telemetry store refuses the event", async () => {
    recordOk = false;
    const r = reporter(() => [entry(5, TOOL_KILL)]);
    expect(await r.check(sample(1), 0, 1)).not.toBeNull();
    expect(recorded).toHaveLength(0);

    recordOk = true;
    await r.check(sample(0), 1_000, 1);
    expect(recorded).toHaveLength(1);

    // Now durably acknowledged: a new incarnation does not repeat it.
    expect(
      await reporter(() => [entry(5, TOOL_KILL)]).check(sample(0), 0, 1),
    ).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  test("an analytics opt-out advances the cursor without recording", async () => {
    consent = false;
    await reporter(() => [entry(5, TOOL_KILL)]).check(sample(1), 0, 1);
    consent = true;
    expect(
      await reporter(() => [entry(5, TOOL_KILL)]).check(sample(0), 0, 1),
    ).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  test("scans on the first tick, on a counter move, and on the fallback cadence", async () => {
    const r = reporter(() => []);
    await r.check(sample(0), 0, 1);
    await r.check(sample(0), 1_000, 1);
    expect(reads).toBe(1);
    await r.check(sample(1), 2_000, 1);
    expect(reads).toBe(2);
    await r.check(sample(0), 61_999, 1);
    expect(reads).toBe(2);
    await r.check(sample(0), 62_000, 1);
    expect(reads).toBe(3);
  });
});
