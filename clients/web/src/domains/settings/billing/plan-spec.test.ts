import { Coins, Computer, HardDrive } from "lucide-react";
import { describe, expect, test } from "bun:test";

import type { ProPackage } from "@/domains/settings/billing/package-types";

import { machineLabel, packageSpecs } from "./plan-spec";

describe("packageSpecs", () => {
  test("uses the free/base baseline for a null package", () => {
    const specs = packageSpecs(null);
    expect(specs.map((s) => s.label)).toEqual([
      "Small Machine",
      "$0 credits",
      "4 GB",
    ]);
    expect(specs.map((s) => s.icon)).toEqual([Computer, Coins, HardDrive]);
  });

  test("reads a machine-less Pro package (Mighty) at the small baseline", () => {
    const specs = packageSpecs({
      key: "mighty",
      name: "Mighty",
      machine_size: null,
      credits_usd: 25,
      storage_gib: 10,
    } as ProPackage);
    expect(specs.map((s) => s.label)).toEqual([
      "Small Machine",
      "$25 credits",
      "10 GB",
    ]);
  });

  test("reads a package with an explicit machine size", () => {
    const specs = packageSpecs({
      machine_size: "medium",
      credits_usd: 45,
      storage_gib: 30,
    } as ProPackage);
    expect(specs.map((s) => s.label)).toEqual([
      "Medium Machine",
      "$45 credits",
      "30 GB",
    ]);
  });

  test("falls back to $0 credits when credits_usd is null", () => {
    const specs = packageSpecs({
      machine_size: "small",
      credits_usd: null,
      storage_gib: 8,
    } as ProPackage);
    expect(specs[1].label).toBe("$0 credits");
  });
});

describe("machineLabel", () => {
  test("returns Small for a null package", () => {
    expect(machineLabel(null)).toBe("Small");
  });

  test("returns the human label for an explicit size", () => {
    expect(machineLabel({ machine_size: "extra_large" } as ProPackage)).toBe(
      "Extra Large",
    );
  });
});
