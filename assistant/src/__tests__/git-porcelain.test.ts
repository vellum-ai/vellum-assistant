import { describe, expect, test } from "bun:test";

import {
  collectDirtyPathsFromPorcelain,
  parsePorcelainZ,
} from "../workspace/git-porcelain.js";

describe("parsePorcelainZ", () => {
  test("parses ordinary modified and untracked records", () => {
    expect(parsePorcelainZ("M  tracked.txt\0?? new.txt\0")).toEqual([
      { status: "M ", path: "tracked.txt" },
      { status: "??", path: "new.txt" },
    ]);
  });

  test("captures rename origin on the same record", () => {
    expect(parsePorcelainZ("R  dest.txt\0src.txt\0")).toEqual([
      { status: "R ", path: "dest.txt", origin: "src.txt" },
    ]);
  });

  test("captures copy origin on the same record", () => {
    expect(parsePorcelainZ("C  dest.txt\0src.txt\0")).toEqual([
      { status: "C ", path: "dest.txt", origin: "src.txt" },
    ]);
  });

  test("skips short leftover NUL entries", () => {
    expect(parsePorcelainZ("M  a.txt\0\0")).toEqual([
      { status: "M ", path: "a.txt" },
    ]);
  });
});

describe("collectDirtyPathsFromPorcelain", () => {
  test("flattens rename origin so both paths are staged", () => {
    expect(
      collectDirtyPathsFromPorcelain("R  dest.txt\0src.txt\0?? extra.txt\0"),
    ).toEqual(["dest.txt", "src.txt", "extra.txt"]);
  });

  test("dedupes a path that appears as both origin and destination", () => {
    expect(collectDirtyPathsFromPorcelain("R  same.txt\0same.txt\0")).toEqual([
      "same.txt",
    ]);
  });
});
