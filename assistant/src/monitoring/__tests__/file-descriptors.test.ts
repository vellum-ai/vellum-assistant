/**
 * Tests for the descriptor poller's pure layers: limit parsing and the pressure
 * decision. The collection functions read fixed `/proc` paths, so only the
 * parsing and threshold logic are exercised here.
 */

import { describe, expect, test } from "bun:test";

import {
  createFdPressureState,
  evaluateFdPressure,
  parseOpenFileLimits,
  type ProcessFdPressure,
  type ProcessFdUsage,
} from "../file-descriptors.js";

const LIMITS = `Limit                     Soft Limit           Hard Limit           Units
Max cpu time              unlimited            unlimited            seconds
Max file size             unlimited            unlimited            bytes
Max open files            1024                 1048576              files
Max locked memory         8388608              8388608              bytes
`;

/** A process whose soft limit is known, so it carries a comparable ratio. */
function usage(fields: {
  pid?: number;
  command?: string;
  openCount: number;
  softLimit?: number;
}): ProcessFdPressure {
  const {
    pid = 1,
    command = "daemon-main",
    openCount,
    softLimit = 1024,
  } = fields;
  return {
    pid,
    command,
    openCount,
    softLimit,
    hardLimit: 1_048_576,
    ratio: openCount / softLimit,
  };
}

describe("parseOpenFileLimits", () => {
  test("reads the soft and hard open-file limits", () => {
    expect(parseOpenFileLimits(LIMITS)).toEqual({
      soft: 1024,
      hard: 1_048_576,
    });
  });

  test("reports null for an unlimited descriptor limit", () => {
    expect(
      parseOpenFileLimits(
        "Max open files            unlimited  unlimited  files\n",
      ),
    ).toEqual({ soft: null, hard: null });
  });

  test("reports null when the row is absent or the file is empty", () => {
    expect(
      parseOpenFileLimits("Max cpu time  unlimited  unlimited  seconds\n"),
    ).toEqual({ soft: null, hard: null });
    expect(parseOpenFileLimits("")).toEqual({ soft: null, hard: null });
  });
});

describe("evaluateFdPressure", () => {
  const options = { thresholdRatio: 0.8, warnCooldownMs: 60_000 };

  test("stays quiet while every process is under the threshold", () => {
    const result = evaluateFdPressure(
      [usage({ openCount: 700 }), usage({ pid: 2, openCount: 100 })],
      options,
      createFdPressureState(),
      1_000,
    );
    expect(result.action).toEqual({ kind: "none" });
    expect(result.state).toEqual({ lastWarnAt: 0, overThreshold: false });
  });

  test("warns on the crossing, naming the over-threshold processes", () => {
    const hot = usage({ pid: 7, openCount: 900 });
    const result = evaluateFdPressure(
      [hot, usage({ pid: 2, openCount: 10 })],
      options,
      createFdPressureState(),
      5_000,
    );
    expect(result.action).toEqual({ kind: "warn", processes: [hot] });
    expect(result.state).toEqual({ lastWarnAt: 5_000, overThreshold: true });
  });

  test("throttles repeats to one warn per cooldown while usage stays over", () => {
    const hot = usage({ openCount: 1000 });
    const warned = { lastWarnAt: 5_000, overThreshold: true };

    const cooling = evaluateFdPressure([hot], options, warned, 30_000);
    expect(cooling.action).toEqual({ kind: "none" });
    // The warn timestamp is preserved so the cooldown measures from the warn.
    expect(cooling.state).toEqual(warned);

    const reWarn = evaluateFdPressure([hot], options, warned, 65_000);
    expect(reWarn.action).toEqual({ kind: "warn", processes: [hot] });
    expect(reWarn.state).toEqual({ lastWarnAt: 65_000, overThreshold: true });
  });

  test("reports recovery once, then goes quiet", () => {
    const cool = usage({ openCount: 10 });
    const recovered = evaluateFdPressure(
      [cool],
      options,
      { lastWarnAt: 5_000, overThreshold: true },
      70_000,
    );
    expect(recovered.action).toEqual({ kind: "recovered" });
    expect(recovered.state).toEqual({ lastWarnAt: 0, overThreshold: false });

    expect(
      evaluateFdPressure([cool], options, recovered.state, 80_000).action,
    ).toEqual({ kind: "none" });
  });

  test("ignores processes whose soft limit is unknown", () => {
    const unlimited: ProcessFdUsage = {
      pid: 3,
      command: "vellum-qdrant",
      openCount: 100_000,
      softLimit: null,
      hardLimit: null,
      ratio: null,
    };
    const result = evaluateFdPressure(
      [unlimited],
      options,
      createFdPressureState(),
      1_000,
    );
    expect(result.action).toEqual({ kind: "none" });
  });
});
