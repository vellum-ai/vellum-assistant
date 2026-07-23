import { describe, expect, test } from "bun:test";

import { resolveCreditPaywallCta } from "./credit-paywall-cta";

describe("resolveCreditPaywallCta", () => {
  test("upgrade arm + free plan → upgrade", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: true, isFreePlan: true }),
    ).toBe("upgrade");
  });

  test("upgrade arm + paid plan → add-credits", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: true, isFreePlan: false }),
    ).toBe("add-credits");
  });

  test("upgrade arm + unresolved plan → add-credits", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: true, isFreePlan: undefined }),
    ).toBe("add-credits");
  });

  test("control arm + free plan → add-credits", () => {
    expect(
      resolveCreditPaywallCta({ isUpgradeArm: false, isFreePlan: true }),
    ).toBe("add-credits");
  });
});
