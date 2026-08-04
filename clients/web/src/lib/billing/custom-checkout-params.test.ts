import { describe, expect, test } from "bun:test";

import type { CustomCheckoutSelection } from "@/lib/billing/custom-checkout-params";
import {
  buildCustomCheckoutSearch,
  parseCustomCheckoutSelection,
} from "@/lib/billing/custom-checkout-params";

describe("parseCustomCheckoutSelection", () => {
  test("parses a fully specified configuration", () => {
    expect(
      parseCustomCheckoutSelection(
        new URLSearchParams(
          "machine_tier=large&storage_tier=s&credit_tier=credits_50",
        ),
      ),
    ).toEqual({
      machineTier: "large",
      storageTier: "s",
      creditTier: "credits_50",
    });
  });

  test("omitted machine and credit tiers read as null", () => {
    expect(
      parseCustomCheckoutSelection(new URLSearchParams("storage_tier=xs")),
    ).toEqual({ machineTier: null, storageTier: "xs", creditTier: null });
  });

  test("returns null when storage_tier is absent", () => {
    expect(
      parseCustomCheckoutSelection(
        new URLSearchParams("machine_tier=medium&credit_tier=credits_10"),
      ),
    ).toBeNull();
  });

  test("returns null for an empty search", () => {
    expect(parseCustomCheckoutSelection(new URLSearchParams())).toBeNull();
  });

  test("rejects the legacy storage tiers the serializer 400s", () => {
    for (const tier of ["xl", "xxl"]) {
      expect(
        parseCustomCheckoutSelection(
          new URLSearchParams(`storage_tier=${tier}`),
        ),
      ).toBeNull();
    }
  });

  test("rejects the package-only credit tiers", () => {
    for (const tier of ["credits_45", "credits_115"]) {
      expect(
        parseCustomCheckoutSelection(
          new URLSearchParams(`storage_tier=m&credit_tier=${tier}`),
        ),
      ).toBeNull();
    }
  });

  test("an invalid machine tier fails the whole parse", () => {
    expect(
      parseCustomCheckoutSelection(
        new URLSearchParams("machine_tier=small&storage_tier=m"),
      ),
    ).toBeNull();
  });

  test("junk values in any dimension fail the whole parse", () => {
    for (const search of [
      "storage_tier=huge",
      "machine_tier=%20&storage_tier=m",
      "storage_tier=m&credit_tier=credits_9999",
      "machine_tier=large&storage_tier=s&credit_tier=free",
    ]) {
      expect(
        parseCustomCheckoutSelection(new URLSearchParams(search)),
      ).toBeNull();
    }
  });

  test("a present-but-empty tier param fails the parse", () => {
    // Never treat a blank value as "unset": the builder omits unset dimensions
    // outright, so a blank one means the URL was mangled in transit.
    expect(
      parseCustomCheckoutSelection(
        new URLSearchParams("machine_tier=&storage_tier=m"),
      ),
    ).toBeNull();
    expect(
      parseCustomCheckoutSelection(new URLSearchParams("storage_tier=")),
    ).toBeNull();
  });

  test("ignores unrelated params on the checkout URL", () => {
    expect(
      parseCustomCheckoutSelection(
        new URLSearchParams(
          "storage_tier=l&continue=/assistant/onboarding/research&utm=x",
        ),
      ),
    ).toEqual({ machineTier: null, storageTier: "l", creditTier: null });
  });
});

describe("buildCustomCheckoutSearch", () => {
  test("writes every set dimension", () => {
    const search = buildCustomCheckoutSearch({
      machineTier: "xl",
      storageTier: "l",
      creditTier: "credits_200",
    });

    expect(search.toString()).toBe(
      "machine_tier=xl&storage_tier=l&credit_tier=credits_200",
    );
  });

  test("omits the params a null dimension stands for", () => {
    const search = buildCustomCheckoutSearch({
      machineTier: null,
      storageTier: "xs",
      creditTier: null,
    });

    expect(search.toString()).toBe("storage_tier=xs");
    expect(search.has("machine_tier")).toBe(false);
    expect(search.has("credit_tier")).toBe(false);
  });
});

describe("build then parse round-trip", () => {
  test("preserves every representative selection", () => {
    const selections: CustomCheckoutSelection[] = [
      { machineTier: null, storageTier: "xs", creditTier: null },
      { machineTier: "medium", storageTier: "s", creditTier: null },
      { machineTier: null, storageTier: "m", creditTier: "credits_25" },
      { machineTier: "xl", storageTier: "l", creditTier: "credits_200" },
    ];

    for (const selection of selections) {
      expect(
        parseCustomCheckoutSelection(buildCustomCheckoutSearch(selection)),
      ).toEqual(selection);
    }
  });
});
