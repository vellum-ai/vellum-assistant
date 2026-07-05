import { describe, expect, test } from "bun:test";

import { parseCpuStat } from "../cgroup-cpu.js";

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
