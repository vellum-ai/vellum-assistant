import { Coins, Computer, HardDrive } from "lucide-react";
import { describe, expect, test } from "bun:test";

import type { ProPackage } from "@/domains/settings/billing/package-types";
import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";

import type { ProPlan } from "@/generated/api/types.gen";
import type { CurrentTiers } from "@/domains/settings/billing/use-change-tiers";

import {
  currentPlanFeatures,
  currentTierRows,
  machineLabel,
  packageHighlights,
  packageSpecs,
} from "./plan-spec";

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

describe("currentTierRows", () => {
  const proPlan = {
    id: "pro",
    // `machine_tiers` is required on ProPlan and is consulted for the machine
    // label, so the fixture carries it even where a test doesn't exercise it.
    machine_tiers: [
      { tier: "medium", label: "Medium" },
      { tier: "large", label: "Large" },
    ],
    credit_tiers: [
      { tier: "credits_50", label: "50 credits", credits_usd: 50 },
      { tier: "credits_25", label: "25 credits", credits_usd: 25 },
    ],
  } as unknown as ProPlan;

  const tiers = (over: Partial<CurrentTiers> = {}): CurrentTiers => ({
    machineTier: "large",
    storageTier: "s",
    storageGib: 30,
    creditTier: "credits_50",
    ...over,
  });

  test("labels all three dimensions from the sub's own tiers", () => {
    expect(currentTierRows(tiers(), proPlan)).toEqual([
      "Large Machine",
      "30 GB",
      "50 credits/mo",
    ]);
  });

  test("falls back to the standard small machine when no paid tier is held", () => {
    expect(currentTierRows(tiers({ machineTier: null }), proPlan)[0]).toBe(
      "Small Machine",
    );
  });

  test("drops storage rather than guessing when the GiB is unresolved", () => {
    expect(currentTierRows(tiers({ storageGib: null }), proPlan)).toEqual([
      "Large Machine",
      "50 credits/mo",
    ]);
  });

  test("drops the credit row entirely when no bundle is held", () => {
    expect(currentTierRows(tiers({ creditTier: null }), proPlan)).toEqual([
      "Large Machine",
      "30 GB",
    ]);
  });

  test("prices a held bundle off the tier key when the catalog dropped it", () => {
    // A delisted tier has no catalog label, but the sub still pays for it, so
    // the amount is recovered from the `credits_<usd>` key.
    expect(
      currentTierRows(tiers({ creditTier: "credits_115" }), proPlan)[2],
    ).toBe("115 credits/mo");
  });

  test("ignores a catalog label that already carries a cadence", () => {
    // The row is composed from `credits_usd`, so a server label formatted as
    // "$50 credits/mo" cannot double up into "50 credits/mo/mo".
    const cadenced = {
      id: "pro",
      credit_tiers: [
        { tier: "credits_50", label: "$50 credits/mo", credits_usd: 50 },
      ],
    } as unknown as ProPlan;
    expect(currentTierRows(tiers(), cadenced)[2]).toBe("50 credits/mo");
  });

  test("renders a zero-credit bundle rather than treating it as absent", () => {
    const freeBundle = {
      id: "pro",
      credit_tiers: [{ tier: "credits_0", label: "None", credits_usd: 0 }],
    } as unknown as ProPlan;
    expect(
      currentTierRows(
        tiers({ creditTier: "credits_0" as CurrentTiers["creditTier"] }),
        freeBundle,
      )[2],
    ).toBe("0 credits/mo");
  });

  test("falls back to a generic bundle label for an unparseable tier key", () => {
    expect(
      currentTierRows(
        tiers({ creditTier: "legacy_bundle" as CurrentTiers["creditTier"] }),
        proPlan,
      )[2],
    ).toBe("Credit bundle");
  });

  test("uses the catalog label for a tier the static map does not know", () => {
    // The tier picker renders the server label, so the card has to agree
    // rather than surfacing the raw identifier.
    const withNewTier = {
      ...proPlan,
      machine_tiers: [{ tier: "xxl", label: "XXL" }],
    } as unknown as ProPlan;
    expect(
      currentTierRows(
        tiers({ machineTier: "xxl" as CurrentTiers["machineTier"] }),
        withNewTier,
      )[0],
    ).toBe("XXL Machine");
  });

  test("passes an unmapped machine tier through rather than dropping it", () => {
    expect(
      currentTierRows(
        tiers({ machineTier: "xxl" as CurrentTiers["machineTier"] }),
        proPlan,
      )[0],
    ).toBe("xxl Machine");
  });
});

describe("currentPlanFeatures", () => {
  const CATALOG = [
    "Pay-as-you-go and bundled credits",
    "Configurable machine size",
    "Configurable storage",
    "Assistant email & subdomain",
  ];
  const proPlan = {
    id: "pro",
    included_features: CATALOG,
    machine_tiers: [{ tier: "large", label: "Large" }],
    credit_tiers: [
      { tier: "credits_50", label: "50 credits", credits_usd: 50 },
    ],
  } as unknown as ProPlan;

  const full: CurrentTiers = {
    machineTier: "large",
    storageTier: "s",
    storageGib: 30,
    creditTier: "credits_50",
  };

  test("replaces every capability row it has a real value for", () => {
    expect(currentPlanFeatures(full, proPlan)).toEqual([
      "Large Machine",
      "30 GB",
      "50 credits/mo",
      "Assistant email & subdomain",
    ]);
  });

  test("keeps the pay-as-you-go row when the sub holds no bundle", () => {
    // Without this the card would say nothing at all about credits, dropping a
    // capability the plan still has.
    expect(currentPlanFeatures({ ...full, creditTier: null }, proPlan)).toEqual([
      "Large Machine",
      "30 GB",
      "Pay-as-you-go and bundled credits",
      "Assistant email & subdomain",
    ]);
  });

  test("keeps the storage row when the GiB is unresolved", () => {
    expect(currentPlanFeatures({ ...full, storageGib: null }, proPlan)).toEqual([
      "Large Machine",
      "50 credits/mo",
      "Configurable storage",
      "Assistant email & subdomain",
    ]);
  });

  test("carries through an entitlement the platform adds later", () => {
    const extended = {
      ...proPlan,
      included_features: [...CATALOG, "Priority support"],
    } as unknown as ProPlan;
    expect(currentPlanFeatures(full, extended)).toContain("Priority support");
  });
});
