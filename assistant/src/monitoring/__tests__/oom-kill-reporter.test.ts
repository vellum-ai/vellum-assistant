import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createOomKillReporter,
  parseKmsgOomKills,
} from "../oom-kill-reporter.js";
import type { ResourceSample } from "../resource-sample-types.js";

const CGROUP_KILL =
  "3,812,44170542,-;Memory cgroup out of memory: Killed process 4242 (python3) total-vm:1263184kB, anon-rss:409600kB, file-rss:1024kB, shmem-rss:0kB, UID:0 pgtables:900kB oom_score_adj:1000";
const LEGACY_KILL =
  "3,900,44170999,-;Out of memory: Killed process 67 (bun) total-vm:3000000kB, anon-rss:2000000kB, file-rss:0kB, shmem-rss:0kB";
const NOISE = [
  "6,811,44170000,-;bun invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=-700",
  " continuation line that must be ignored",
  "6,813,44170600,-;oom_reaper: reaped process 4242 (python3), now anon-rss:0kB, file-rss:0kB, shmem-rss:0kB",
].join("\n");

function sample(oomKillDelta: number | null): ResourceSample {
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
    events: null,
    deltas:
      oomKillDelta == null
        ? null
        : {
            events: { low: 0, high: 0, max: 0, oom: 0, oomKill: oomKillDelta },
            reclaim: null,
            cpu: null,
          },
    disk: null,
    activeConversations: null,
  };
}

describe("parseKmsgOomKills", () => {
  test("extracts victim, sizes and oom_score_adj from cgroup and legacy lines", () => {
    expect(
      parseKmsgOomKills([NOISE, CGROUP_KILL, LEGACY_KILL].join("\n")),
    ).toEqual([
      {
        seq: 812,
        pid: 4242,
        comm: "python3",
        oomScoreAdj: 1000,
        anonRssKb: 409600,
        totalVmKb: 1263184,
      },
      {
        seq: 900,
        pid: 67,
        comm: "bun",
        oomScoreAdj: null,
        anonRssKb: 2000000,
        totalVmKb: 3000000,
      },
    ]);
  });
});

describe("createOomKillReporter", () => {
  let dir: string;
  let recorded: Array<{ value?: number | null; detail?: unknown }>;
  let reads: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oom-kill-reporter-"));
    recorded = [];
    reads = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reporter(kmsg: () => string | null, bootId = "boot-a") {
    return createOomKillReporter({
      readKmsg: () => {
        reads++;
        return kmsg();
      },
      readBootId: () => bootId,
      cursorPath: join(dir, "cursor.json"),
      record: (record) => {
        recorded.push(record);
        return { id: "evt", createdAt: 0 };
      },
    });
  }

  test("reports fresh kills once and flags a dead daemon", () => {
    const r = reporter(() => [CGROUP_KILL, LEGACY_KILL].join("\n"));

    const first = r.check(sample(1), 1_000, 67);
    expect(first.map((k) => k.pid)).toEqual([4242, 67]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].value).toBe(2);
    expect(recorded[0].detail).toMatchObject({
      victim_count: 2,
      killed_daemon: true,
      daemon_pid: 67,
      memory_limit_bytes: 3_221_225_472,
    });

    // Same kernel log again: the cursor suppresses a repeat.
    expect(r.check(sample(1), 2_000, 67)).toEqual([]);
    expect(recorded).toHaveLength(1);
  });

  test("a restarted monitor picks up the kill that preceded it, and only once", () => {
    const first = reporter(() => CGROUP_KILL);
    expect(first.check(sample(null), 1_000, 67)).toHaveLength(1);

    const second = reporter(() => CGROUP_KILL);
    expect(second.check(sample(null), 1_000, 68)).toEqual([]);
    expect(recorded).toHaveLength(1);
  });

  test("a new kernel boot resets the cursor", () => {
    reporter(() => LEGACY_KILL, "boot-a").check(sample(null), 1_000, 67);
    const afterReboot = reporter(() => CGROUP_KILL, "boot-b");
    expect(afterReboot.check(sample(null), 1_000, 90)).toHaveLength(1);
    expect(recorded).toHaveLength(2);
    expect(recorded[1].detail).toMatchObject({ killed_daemon: false });
  });

  test("scans on the first tick, on a counter move, and on the fallback cadence", () => {
    const r = reporter(() => "");
    r.check(sample(0), 0, 67);
    r.check(sample(0), 1_000, 67);
    expect(reads).toBe(1);
    r.check(sample(1), 2_000, 67);
    expect(reads).toBe(2);
    r.check(sample(0), 61_999, 67);
    expect(reads).toBe(2);
    r.check(sample(0), 62_000, 67);
    expect(reads).toBe(3);
  });

  test("does nothing when the kernel log is unavailable", () => {
    const r = reporter(() => null);
    expect(r.check(sample(1), 0, 67)).toEqual([]);
    expect(recorded).toHaveLength(0);
  });
});
