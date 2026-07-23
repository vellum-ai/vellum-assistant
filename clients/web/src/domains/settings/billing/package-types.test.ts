import { describe, expect, test } from "bun:test";

import {
  packageRank,
  proPackageDisplayName,
  tierRelation,
} from "./package-types";

describe("proPackageDisplayName", () => {
  test("names a clean pin", () => {
    expect(
      proPackageDisplayName({
        key: "super",
        name: "Super",
        version: 1,
        customized: false,
      }),
    ).toBe("Super");
  });

  test("reads Custom for a customized pin", () => {
    expect(
      proPackageDisplayName({
        key: "super",
        name: "Super",
        version: 1,
        customized: true,
      }),
    ).toBe("Custom");
  });

  test("reads Custom for an unpinned sub", () => {
    expect(proPackageDisplayName(null)).toBe("Custom");
    expect(proPackageDisplayName(undefined)).toBe("Custom");
  });
});

describe("packageRank", () => {
  test("ranks tiers in ascending order", () => {
    expect(packageRank("free")).toBe(0);
    expect(packageRank("mighty")).toBe(1);
    expect(packageRank("super")).toBe(2);
    expect(packageRank("ultra")).toBe(3);
  });

  test("returns -1 for unknown keys", () => {
    expect(packageRank("bogus")).toBe(-1);
  });
});

describe("tierRelation", () => {
  test("classifies targets for a Pro-on-super user", () => {
    expect(tierRelation("super", "super")).toBe("current");
    expect(tierRelation("super", "mighty")).toBe("downgrade");
    expect(tierRelation("super", "free")).toBe("downgrade");
    expect(tierRelation("super", "ultra")).toBe("upgrade");
  });

  test("defaults every tier to upgrade when current is null", () => {
    expect(tierRelation(null, "free")).toBe("upgrade");
    expect(tierRelation(null, "mighty")).toBe("upgrade");
    expect(tierRelation(null, "ultra")).toBe("upgrade");
  });

  test("defaults to upgrade when current key is unknown", () => {
    expect(tierRelation("bogus", "super")).toBe("upgrade");
  });

  test("defaults to upgrade when target key is unknown", () => {
    expect(tierRelation("super", "enterprise")).toBe("upgrade");
    expect(tierRelation("mighty", "bogus")).toBe("upgrade");
  });
});
