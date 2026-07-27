import { Coins, Computer, HardDrive } from "lucide-react";
import { describe, expect, test } from "bun:test";

import type { ProPackage } from "@/domains/settings/billing/package-types";
import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";

import { machineLabel, packageHighlights, packageSpecs } from "./plan-spec";

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

  test("formats a sub-dollar credit amount cents-aware", () => {
    const specs = packageSpecs({
      machine_size: "small",
      credits_usd: 0.5,
      storage_gib: 8,
    } as ProPackage);
    expect(specs[1].label).toBe("$0.50 credits");
  });
});

describe("packageHighlights", () => {
  test("spells out the machine's resource detail for an explicit size", () => {
    expect(
      packageHighlights({
        machine_size: "large",
        credits_usd: 100,
        storage_gib: 50,
      } as ProPackage),
    ).toEqual([
      "Large machine (4 vCPU, 8 GiB)",
      "50 GB storage",
      "$100 of bundled credits",
    ]);
  });

  test("reads a machine-less Pro package (Mighty) at the small baseline", () => {
    expect(
      packageHighlights({
        machine_size: null,
        credits_usd: 25,
        storage_gib: 10,
      } as ProPackage),
    ).toEqual([
      "Small machine (2 vCPU, 3 GiB)",
      "10 GB storage",
      "$25 of bundled credits",
    ]);
  });

  test("uses the free/base baseline for a null package", () => {
    expect(packageHighlights(null)).toEqual([
      "Small machine (2 vCPU, 3 GiB)",
      `${FREE_STORAGE_GIB} GB storage`,
      `$${FREE_CREDITS_USD} of bundled credits`,
    ]);
  });

  test("appends extra rows in order after the derived rows", () => {
    expect(
      packageHighlights(
        {
          machine_size: "medium",
          credits_usd: 45,
          storage_gib: 30,
        } as ProPackage,
        ["Priority support", "Custom domains"],
      ),
    ).toEqual([
      "Medium machine (2.5 vCPU, 5 GiB)",
      "30 GB storage",
      "$45 of bundled credits",
      "Priority support",
      "Custom domains",
    ]);
  });

  test("omits the resource detail for an unrecognized machine size", () => {
    expect(
      packageHighlights({ machine_size: "gigantic" } as ProPackage)[0],
    ).toBe("gigantic machine");
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
