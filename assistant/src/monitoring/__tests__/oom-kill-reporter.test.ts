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
  parseOwnContainerIds,
} from "../oom-kill-reporter.js";
import type { ResourceSample } from "../resource-sample-types.js";

const OUR_ID =
  "de939a251b36f11a400aab40a43b756ca376056239227aec2795953ca219e7d5";
const OTHER_ID =
  "0f4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6";
const memcg = (id: string) =>
  `/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-poda5d2033b.slice/cri-containerd-${id}.scope`;

const header = (pid: number, comm: string, id: string) =>
  `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=cri-containerd-${id}.scope,mems_allowed=0,oom_memcg=${memcg(id)},task_memcg=${memcg(id)},task=${comm},pid=${pid},uid=0`;
const killed = (
  pid: number,
  comm: string,
  adj: number | null,
  anonKb = 409600,
) =>
  `Memory cgroup out of memory: Killed process ${pid} (${comm}) total-vm:1263184kB, anon-rss:${anonKb}kB, file-rss:1024kB, shmem-rss:0kB, UID:0 pgtables:900kB${adj == null ? "" : ` oom_score_adj:${adj}`}`;

const entry = (time: number, msg: string): KernelLogEntry => ({ time, msg });
/** A kill with its header, as the kernel logs it when not rate-limited. */
const ourKill = (time: number, pid: number, adj = 1000): KernelLogEntry[] => [
  entry(time - 0.00001, header(pid, "python3", OUR_ID)),
  entry(time, killed(pid, "python3", adj)),
];
const theirKill = (time: number, pid: number): KernelLogEntry[] => [
  entry(time - 0.00001, header(pid, "node", OTHER_ID)),
  entry(time, killed(pid, "node", 0)),
];
/** A kill whose header the kernel rate-limited away. */
const bareKill = (time: number, pid: number): KernelLogEntry[] => [
  entry(time, killed(pid, "python3", 1000)),
];

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
    const msg = killed(4242, "python3", 1000);
    const json = `{"dmesg":[{"pri":3,"time":  44170.542000,"msg":${JSON.stringify(msg)}},{"pri":6,"time":44171.0,"msg":"x"}]}`;
    const text = `[44170.542000] ${msg}\n[   44171.000000] x\n`;
    expect(parseDmesgJson(json)).toEqual(parseDmesgText(text));
    expect(parseDmesgJson("not json")).toBeNull();
  });

  test("pairs each kill with its header and tolerates missing headers and noise", () => {
    const kills = oomKillsFromEntries([
      entry(
        30,
        "bun invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=-700",
      ),
      ...ourKill(31, 4242),
      entry(32, "oom_reaper: reaped process 4242 (python3), now anon-rss:0kB"),
      entry(50, killed(77, "node", null, 300000)),
    ]);
    expect(kills).toEqual([
      {
        time: 31,
        pid: 4242,
        comm: "python3",
        oomScoreAdj: 1000,
        anonRssKb: 409600,
        totalVmKb: 1263184,
        memcg: memcg(OUR_ID),
      },
      {
        time: 50,
        pid: 77,
        comm: "node",
        oomScoreAdj: null,
        anonRssKb: 300000,
        totalVmKb: 1263184,
        memcg: null,
      },
    ]);
  });

  test("finds the container id in the runtime-named mounts only", () => {
    const layer =
      "aaaa000000000000000000000000000000000000000000000000000000000000";
    const mountinfo = [
      `151 137 0:34 /${OUR_ID}-1f3ead8083566ffb-hosts /etc/hosts rw,relatime - virtiofs kataShared rw`,
      `152 139 0:34 /${OUR_ID}-175b29da4eda0e77-termination-log /dev/termination-log rw,relatime - virtiofs kataShared rw`,
      `140 120 0:30 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/x/${layer}/fs`,
    ].join("\n");
    expect(parseOwnContainerIds(mountinfo)).toEqual(new Set([OUR_ID]));
  });
});

describe("createOomKillReporter", () => {
  let dir: string;
  let recorded: Array<{ value?: number | null; detail?: unknown }>;
  let reads: number;
  let recordOk: boolean;
  let consent: boolean | null;
  let killCounter: number | null;
  let entries: KernelLogEntry[] | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oom-kill-reporter-"));
    recorded = [];
    reads = 0;
    recordOk = true;
    consent = true;
    killCounter = 0;
    entries = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reporter(bootId: string | null = "boot-a") {
    return createOomKillReporter({
      readKernelLog: async () => {
        reads++;
        return entries;
      },
      readKillCounter: () => killCounter,
      readOwnContainerIds: () => new Set([OUR_ID]),
      readBootId: () => bootId,
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

  const pids = (report: { victims: { pid: number }[] } | null) =>
    report?.victims.map((v) => v.pid) ?? [];

  test("attributes by the header's cgroup regardless of order or count", async () => {
    const r = reporter();
    await r.check(sample(0), 0, 1);

    entries = [...theirKill(70, 900), ...ourKill(80, 4242)];
    killCounter = 1;
    const report = await r.check(sample(1), 1_000, 1);
    expect(report?.attribution).toBe("cgroup");
    expect(pids(report)).toEqual([4242]);
    expect(recorded[0].detail).toMatchObject({ killed_daemon: false });
  });

  test("uses the counter for header-less kills, oldest first; the rest are neighbours'", async () => {
    const r = reporter();
    await r.check(sample(0), 0, 1);

    entries = [...bareKill(20, 1), ...bareKill(21, 2), ...bareKill(22, 3)];
    killCounter = 2;
    const first = await r.check(sample(2), 1_000, 1);
    expect(first).toMatchObject({ attribution: "cgroup_counter", unnamed: 0 });
    expect(pids(first)).toEqual([1, 2]);

    // The third was logged but not counted, so it was another container's.
    expect(await r.check(sample(0), 61_000, 1)).toBeNull();
    expect(recorded).toHaveLength(1);
  });
  test("spends counter credit on the next scan and reports it unnamed only if unspent", async () => {
    const r = reporter();
    await r.check(sample(0), 0, 1);

    // The kill is counted but its line is not yet visible: nothing to say yet.
    killCounter = 1;
    expect(await r.check(sample(1), 1_000, 1)).toBeNull();

    entries = [...bareKill(5, 1)];
    const spent = await r.check(sample(0), 61_000, 1);
    expect(spent).toMatchObject({ attribution: "cgroup_counter", unnamed: 0 });
    expect(pids(spent)).toEqual([1]);

    // Credit that never finds a line is reported unnamed after one scan.
    killCounter = 2;
    expect(await r.check(sample(1), 62_000, 1)).toBeNull();
    const expired = await r.check(sample(0), 123_000, 1);
    expect(expired).toEqual({
      attribution: "cgroup_counter",
      victims: [],
      unnamed: 1,
    });
  });
  test("names every victim of a burst where the kernel rate-limits headers", async () => {
    const r = reporter();
    await r.check(sample(0), 0, 1);

    const victims = [468, 472, 474, 477, 476, 467, 480, 471, 478, 473, 481];
    const headerless = new Set([474, 468]);
    const perKill = victims.map((pid, i) =>
      headerless.has(pid)
        ? bareKill(216386 + i * 0.15, pid)
        : ourKill(216386 + i * 0.15, pid),
    );
    // Kills visible in the log, then the counter read after them, per tick.
    const ticks: Array<[number, number]> = [
      [2, 2],
      [5, 6],
      [8, 8],
      [11, 11],
    ];
    const named: number[] = [];
    let t = 1_000;
    for (const [visible, counter] of ticks) {
      entries = perKill.slice(0, visible).flat();
      killCounter = counter;
      const report = await r.check(sample(1), (t += 250), 1);
      named.push(...pids(report));
    }
    expect([...named].sort((a, b) => a - b)).toEqual(
      [...victims].sort((a, b) => a - b),
    );
    expect(recorded.reduce((n, e) => n + (e.value ?? 0), 0)).toBe(11);
  });

  test("first scan reports the kill that preceded the monitor and flags the daemon by score", async () => {
    entries = [...ourKill(5, 1, -700)];
    const report = await reporter().check(sample(0), 0, 999);
    expect(report?.attribution).toBe("kernel_log");
    expect(recorded[0].detail).toMatchObject({
      killed_daemon: true,
      victim_count: 1,
      memory_limit_bytes: 3_221_225_472,
    });

    // A second incarnation on the same kernel sees the same log: nothing new.
    expect(await reporter().check(sample(0), 0, 999)).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  test("first scan still excludes kills the header assigns elsewhere", async () => {
    entries = [...theirKill(4, 900), ...ourKill(5, 1)];
    expect(pids(await reporter().check(sample(0), 0, 1))).toEqual([1]);
  });

  test("ignores header-less neighbours' kills when the local counter did not move", async () => {
    const r = reporter();
    await r.check(sample(0), 0, 1);
    entries = [...bareKill(70, 900)];
    expect(await r.check(sample(0), 61_000, 1)).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  test("reports every new kill when there is no counter at all", async () => {
    killCounter = null;
    entries = [...bareKill(5, 1)];
    await reporter().check(sample(null, false), 0, 1);
    entries = [...bareKill(5, 1), ...bareKill(9, 2)];
    const report = await reporter().check(sample(null, false), 61_000, 1);
    expect(report?.attribution).toBe("kernel_log");
    expect(pids(report)).toEqual([2]);
  });

  test("skips a scan when a counter that exists fails to read", async () => {
    const r = reporter();
    await r.check(sample(0), 0, 1);
    entries = [...bareKill(70, 900)];
    killCounter = null;
    expect(await r.check(sample(1), 1_000, 1)).toBeNull();
    expect(recorded).toHaveLength(0);
    // The scan was not consumed: the kill is still claimable once the counter reads.
    killCounter = 1;
    expect(pids(await r.check(sample(0), 1_250, 1))).toEqual([900]);
  });

  test("a counter move with no readable log still produces an event, and does not double-count later", async () => {
    entries = null;
    killCounter = 3;
    const r = reporter();
    const report = await r.check(sample(3), 0, 1);
    expect(report).toEqual({
      attribution: "cgroup_counter",
      victims: [],
      unnamed: 3,
    });
    expect(recorded[0]).toMatchObject({ value: 3 });

    entries = [...bareKill(1, 1), ...bareKill(2, 2), ...bareKill(3, 3)];
    expect(await r.check(sample(0), 61_000, 1)).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  test("a rebooted kernel resets the cursor even when the boot id is unreadable", async () => {
    entries = [...bareKill(500, 1)];
    await reporter(null).check(sample(0), 0, 1);
    entries = [...bareKill(5, 1)];
    const report = await reporter(null).check(sample(0), 0, 1);
    expect(report?.victims).toHaveLength(1);
    expect(recorded).toHaveLength(2);
  });

  test("keeps the cursor and retries when the telemetry store refuses the event", async () => {
    const r = reporter();
    await r.check(sample(0), 0, 1);
    recordOk = false;
    entries = [...ourKill(5, 1)];
    killCounter = 1;
    expect(await r.check(sample(1), 1_000, 1)).not.toBeNull();
    expect(recorded).toHaveLength(0);

    recordOk = true;
    await r.check(sample(0), 2_000, 1);
    expect(recorded).toHaveLength(1);

    // Durably acknowledged: a new incarnation does not repeat it.
    expect(await reporter().check(sample(0), 0, 1)).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  test("an analytics opt-out advances the cursor without recording", async () => {
    consent = false;
    entries = [...ourKill(5, 1)];
    await reporter().check(sample(0), 0, 1);
    consent = true;
    expect(await reporter().check(sample(0), 0, 1)).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  test("scans on the first tick, on a counter move, and on the fallback cadence", async () => {
    const r = reporter();
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
