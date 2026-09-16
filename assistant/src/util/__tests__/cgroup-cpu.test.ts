import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as env from "../../config/env-registry.js";
import { getContainerCpuCores, parseCpuStat } from "../cgroup-cpu.js";

describe("parseCpuStat", () => {
  test("extracts usage and throttle counters", () => {
    const raw = `usage_usec 4500000000
user_usec 3000000000
system_usec 1500000000
nr_periods 120000
nr_throttled 350
throttled_usec 21000000
`;
    expect(parseCpuStat(raw)).toEqual({
      usageUsec: 4500000000,
      userUsec: 3000000000,
      systemUsec: 1500000000,
      nrPeriods: 120000,
      nrThrottled: 350,
      throttledUsec: 21000000,
    });
  });

  test("reports null for missing counters", () => {
    // Throttle counters are absent when no CPU limit is set.
    const stat = parseCpuStat("usage_usec 100\nuser_usec 60\nsystem_usec 40\n");
    expect(stat.usageUsec).toBe(100);
    expect(stat.nrThrottled).toBeNull();
    expect(stat.throttledUsec).toBeNull();
  });
});

describe("getContainerCpuCores", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
  });

  for (const scenario of [
    {
      name: "unlimited quota",
      quota: "max 100000",
      envLimit: undefined,
      expected: 2,
    },
    {
      name: "quota above affinity",
      quota: "800000 100000",
      envLimit: undefined,
      expected: 2,
    },
    {
      name: "quota below affinity",
      quota: "50000 100000",
      envLimit: undefined,
      expected: 0.5,
    },
    {
      name: "platform limit above affinity",
      quota: "max 100000",
      envLimit: "8",
      expected: 2,
    },
    {
      name: "platform limit below affinity",
      quota: "max 100000",
      envLimit: "500m",
      expected: 0.5,
    },
  ]) {
    test(`honors a two-CPU affinity with ${scenario.name} on a 16-CPU host`, () => {
      const originalRead = fs.readFileSync;
      const read = spyOn(fs, "readFileSync").mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        if (args[0] === "/sys/fs/cgroup/cpu.max") {
          return scenario.quota;
        }
        if (String(args[0]).startsWith("/sys/fs/cgroup/cpu/")) {
          throw new Error("No cgroup v1 mount");
        }
        return originalRead(...args);
      }) as typeof fs.readFileSync);
      restores.push(() => read.mockRestore());
      const affinity = spyOn(os, "availableParallelism").mockReturnValue(2);
      restores.push(() => affinity.mockRestore());
      const host = spyOn(os, "cpus").mockReturnValue(
        Array.from({ length: 16 }, () => ({}) as os.CpuInfo),
      );
      restores.push(() => host.mockRestore());
      const limit = spyOn(env, "getCpuLimit").mockReturnValue(
        scenario.envLimit,
      );
      restores.push(() => limit.mockRestore());
      const platform = spyOn(env, "getIsPlatform").mockReturnValue(false);
      restores.push(() => platform.mockRestore());
      expect(getContainerCpuCores()).toBe(scenario.expected);
    });
  }
});
