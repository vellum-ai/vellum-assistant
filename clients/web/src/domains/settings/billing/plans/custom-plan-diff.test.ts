/**
 * Unit tests for the pure custom-plan diff/recap computation.
 *
 * Mirrors the recap the modal renders: a base-checkout selection (no seed)
 * produces null delta and all-unchanged rows; a seeded Pro reconfigure produces
 * a signed cents delta and marks only the changed dimensions, carrying the
 * previous value's label where it is representable.
 */

import { describe, expect, test } from "bun:test";

import type { ProPlan } from "@/generated/api/types.gen";

import { NO_EXTRA_CREDITS, computeCustomPlanDiff } from "./custom-plan-diff";

function proPlan(): ProPlan {
  return {
    id: "pro",
    name: "Pro",
    base_price_cents: 2000,
    base_lookup_key: "pro_base",
    billing_interval: "month",
    included_features: [],
    machine_tiers: [
      {
        tier: "medium",
        label: "medium",
        price_cents: 3500,
        lookup_key: "machine_m",
        cpu_limit: "2.5",
        memory_gib: 5,
        description: "Medium machine (2.5 vCPU, 5 GiB)",
      },
      {
        tier: "large",
        label: "large",
        price_cents: 6000,
        lookup_key: "machine_l",
        cpu_limit: "4",
        memory_gib: 8,
        description: "Large machine (4 vCPU, 8 GiB)",
      },
    ],
    storage_tiers: [
      {
        tier: "xs",
        label: "10 GB",
        storage_gib: 10,
        price_cents: 500,
        lookup_key: "storage_10",
        legacy: false,
      },
      {
        tier: "s",
        label: "30 GB",
        storage_gib: 30,
        price_cents: 1000,
        lookup_key: "storage_30",
        legacy: false,
      },
      {
        tier: "xl",
        label: "250 GB",
        storage_gib: 250,
        price_cents: 6000,
        lookup_key: "storage_250",
        legacy: true,
      },
    ],
    credit_tiers: [
      {
        tier: "credits_50",
        label: "50 credits",
        credits_usd: 50,
        price_cents: 5000,
        lookup_key: "credits_50",
      },
    ],
    packages: [],
  };
}

describe("computeCustomPlanDiff — base checkout (no seed)", () => {
  test("full selection has null delta and all rows unchanged", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: null,
      machineTier: "large",
      storageTier: "s",
      creditChoice: "credits_50",
    });

    expect(diff.deltaCents).toBeNull();
    expect(diff.previousTotalCents).toBeNull();
    expect(diff.rows.map((r) => r.label)).toEqual([
      "Pro base plan — $20/mo",
      "Large machine (4 vCPU, 8 GiB)",
      "30 GB storage",
      "$50 of bundled credits",
    ]);
    expect(diff.rows.every((r) => !r.changed)).toBe(true);
    expect(diff.rows.every((r) => r.previousLabel === undefined)).toBe(true);
    expect(diff.rows[0].key).toBe("base");
  });

  test("'No extra credits' renders the none label", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: null,
      machineTier: "medium",
      storageTier: "xs",
      creditChoice: NO_EXTRA_CREDITS,
    });

    expect(diff.rows.map((r) => r.label)).toEqual([
      "Pro base plan — $20/mo",
      "Medium machine (2.5 vCPU, 5 GiB)",
      "10 GB storage",
      "No extra credits",
    ]);
  });

  test("incomplete selection omits the unset dimensions", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: null,
      machineTier: "",
      storageTier: "s",
      creditChoice: "",
    });

    expect(diff.rows.map((r) => r.key)).toEqual(["base", "storage"]);
  });

  test("selecting a non-legacy tier still resolves normally", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: null,
      machineTier: "medium",
      storageTier: "s",
      creditChoice: NO_EXTRA_CREDITS,
    });

    const storageRow = diff.rows.find((r) => r.key === "storage");
    expect(storageRow?.label).toBe("30 GB storage");
  });
});

describe("computeCustomPlanDiff — seeded reconfigure", () => {
  test("no-op selection has zero delta and no changed rows", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: { machineTier: "medium", storageTier: "xs", creditTier: null },
      machineTier: "medium",
      storageTier: "xs",
      creditChoice: NO_EXTRA_CREDITS,
    });

    expect(diff.deltaCents).toBe(0);
    expect(diff.previousTotalCents).toBe(2000 + 3500 + 500);
    expect(diff.rows.every((r) => !r.changed)).toBe(true);
    expect(diff.rows.every((r) => r.previousLabel === undefined)).toBe(true);
  });

  test("a machine increase marks the machine row and carries the previous label", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: { machineTier: "medium", storageTier: "xs", creditTier: null },
      machineTier: "large",
      storageTier: "xs",
      creditChoice: NO_EXTRA_CREDITS,
    });

    expect(diff.deltaCents).toBe(2500);
    const machineRow = diff.rows.find((r) => r.key === "machine");
    expect(machineRow?.changed).toBe(true);
    expect(machineRow?.previousLabel).toBe("Medium machine (2.5 vCPU, 5 GiB)");
    expect(machineRow?.label).toBe("Large machine (4 vCPU, 8 GiB)");

    // Every other row stayed unchanged.
    for (const row of diff.rows) {
      if (row.key !== "machine") {
        expect(row.changed).toBe(false);
      }
    }
  });

  test("a machine decrease yields a negative delta", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: { machineTier: "large", storageTier: "xs", creditTier: null },
      machineTier: "medium",
      storageTier: "xs",
      creditChoice: NO_EXTRA_CREDITS,
    });

    expect(diff.deltaCents).toBe(-2500);
    expect(diff.rows.find((r) => r.key === "machine")?.changed).toBe(true);
  });

  test("adding a credit bundle marks the credit row from the none baseline", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: { machineTier: "medium", storageTier: "xs", creditTier: null },
      machineTier: "medium",
      storageTier: "xs",
      creditChoice: "credits_50",
    });

    expect(diff.deltaCents).toBe(5000);
    const creditRow = diff.rows.find((r) => r.key === "credit");
    expect(creditRow?.changed).toBe(true);
    expect(creditRow?.previousLabel).toBe("No extra credits");
    expect(creditRow?.label).toBe("$50 of bundled credits");
  });

  test("a null baseline seed machine changes without a previous label", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: { machineTier: null, storageTier: "xs", creditTier: null },
      machineTier: "medium",
      storageTier: "xs",
      creditChoice: NO_EXTRA_CREDITS,
    });

    expect(diff.deltaCents).toBe(3500);
    const machineRow = diff.rows.find((r) => r.key === "machine");
    expect(machineRow?.changed).toBe(true);
    expect(machineRow?.previousLabel).toBeUndefined();
    expect(machineRow?.label).toBe("Medium machine (2.5 vCPU, 5 GiB)");
  });

  test("a legacy seed storage tier resolves and contributes its real price", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      // xl is a legacy tier ($60 / 250 GB) the subscriber still pays for.
      seed: { machineTier: "medium", storageTier: "xl", creditTier: null },
      machineTier: "medium",
      storageTier: "s",
      creditChoice: NO_EXTRA_CREDITS,
    });

    // The legacy seed resolves against the full catalog, so its price is in the
    // previous total and the delta reflects it (30 GB $10 − legacy 250 GB $60).
    expect(diff.previousTotalCents).toBe(2000 + 3500 + 6000);
    expect(diff.deltaCents).toBe(-5000);
    const storageRow = diff.rows.find((r) => r.key === "storage");
    expect(storageRow?.changed).toBe(true);
    expect(storageRow?.previousLabel).toBe("250 GB storage");
    expect(storageRow?.label).toBe("30 GB storage");
  });

  test("removing a deprecated seed credit bundle is detected as a change", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      // credits_100 is not present in the fixture's credit_tiers (deprecated).
      seed: {
        machineTier: "medium",
        storageTier: "xs",
        creditTier: "credits_100",
      },
      machineTier: "medium",
      storageTier: "xs",
      creditChoice: NO_EXTRA_CREDITS,
    });

    const creditRow = diff.rows.find((r) => r.key === "credit");
    expect(creditRow?.changed).toBe(true);
    expect(creditRow?.label).toBe("No extra credits");
    // The deprecated bundle's price/label is absent from the catalog → omitted.
    expect(creditRow?.previousLabel).toBeUndefined();
  });

  test("switching from a deprecated seed credit to a live bundle is a change with no previous label", () => {
    const diff = computeCustomPlanDiff({
      proPlan: proPlan(),
      seed: {
        machineTier: "medium",
        storageTier: "xs",
        creditTier: "credits_100",
      },
      machineTier: "medium",
      storageTier: "xs",
      creditChoice: "credits_50",
    });

    const creditRow = diff.rows.find((r) => r.key === "credit");
    expect(creditRow?.changed).toBe(true);
    expect(creditRow?.label).toBe("$50 of bundled credits");
    expect(creditRow?.previousLabel).toBeUndefined();
  });
});
