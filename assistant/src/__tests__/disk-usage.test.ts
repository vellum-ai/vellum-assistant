import { beforeEach, describe, expect, mock, test } from "bun:test";

const MIB = 1024 * 1024;
const workspaceDir = "/workspace";
let existingPaths = new Set<string>();
let statfsResult = { bsize: MIB, blocks: 100, bavail: 25 };
let statfsError = false;
let statfsPaths: string[] = [];

mock.module("node:fs", () => ({
  existsSync: (path: string) => existingPaths.has(path),
  statfsSync: (path: string) => {
    statfsPaths.push(path);
    if (statfsError) {
      throw new Error("Filesystem unavailable");
    }
    return statfsResult;
  },
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => workspaceDir,
}));

const { getDiskUsageInfo, parseK8sMemoryBytes } =
  await import("../util/disk-usage.js");

describe("disk usage sampler", () => {
  beforeEach(() => {
    existingPaths = new Set([workspaceDir]);
    statfsResult = { bsize: MIB, blocks: 100, bavail: 25 };
    statfsError = false;
    statfsPaths = [];
  });

  test("reports the workspace filesystem capacity and available space", async () => {
    expect(await getDiskUsageInfo()).toEqual({
      path: workspaceDir,
      totalMb: 100,
      usedMb: 75,
      freeMb: 25,
    });
    expect(statfsPaths).toEqual([workspaceDir]);
  });

  test("falls back to root when the workspace path does not exist", async () => {
    existingPaths = new Set();
    expect((await getDiskUsageInfo())?.path).toBe("/");
    expect(statfsPaths).toEqual(["/"]);
  });

  test("reports fresh filesystem counters on each call", async () => {
    await getDiskUsageInfo();
    statfsResult = { bsize: MIB, blocks: 100, bavail: 10 };
    expect((await getDiskUsageInfo())?.freeMb).toBe(10);
  });

  test("does not aggregate a separate data mount", async () => {
    existingPaths.add("/data");
    expect((await getDiskUsageInfo())?.usedMb).toBe(75);
    expect(statfsPaths).toEqual([workspaceDir]);
  });

  test("returns null when filesystem statistics are unavailable", async () => {
    statfsError = true;
    expect(await getDiskUsageInfo()).toBeNull();
  });

  test("rounds filesystem counters to two decimal places in MiB", async () => {
    statfsResult = { bsize: 4096, blocks: 1000, bavail: 333 };
    expect(await getDiskUsageInfo()).toEqual({
      path: workspaceDir,
      totalMb: 3.91,
      usedMb: 2.61,
      freeMb: 1.3,
    });
  });

  test("parses Kubernetes memory units for memory callers", () => {
    expect(parseK8sMemoryBytes("1Gi")).toBe(1024 * MIB);
    expect(parseK8sMemoryBytes("512Mi")).toBe(512 * MIB);
  });

  test("returns null for malformed Kubernetes memory strings", () => {
    for (const value of ["", "abc", "12Zi", "-1Gi", "0Gi"]) {
      expect(parseK8sMemoryBytes(value)).toBeNull();
    }
  });
});
