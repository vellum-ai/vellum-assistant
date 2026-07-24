import { describe, expect, test } from "bun:test";

import { resolveCreditPaywallCta } from "./credit-paywall-cta";

describe("resolveCreditPaywallCta", () => {
  test("upgrade arm + free plan → upgrade", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: true, isFreePlan: true }),
    ).toBe("upgrade");
  });

  test("upgrade arm + paid plan → add-credits-paid", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: true, isFreePlan: false }),
    ).toBe("add-credits-paid");
  });

  test("upgrade arm + unresolved plan → add-credits-paid", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: true, isFreePlan: undefined }),
    ).toBe("add-credits-paid");
  });

  test("control arm + free plan → add-credits-free", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: false, isFreePlan: true }),
    ).toBe("add-credits-free");
  });

  test("control arm + paid plan → add-credits-paid", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: false, isFreePlan: false }),
    ).toBe("add-credits-paid");
  });

  test("control arm + unresolved plan → add-credits-paid", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: false, isFreePlan: undefined }),
    ).toBe("add-credits-paid");
  });
});
