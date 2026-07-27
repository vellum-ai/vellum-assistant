/**
 * Unit tests for the relation-keyed package-switch confirm copy.
 *
 * The three `toEqual` cases pin every field of every relation, so the one extra
 * test below only earns its place by covering an input those three don't: a
 * tier key the bundle has no copy for.
 *
 * The downgrade variant carries the safeguards: an explicit destructive CTA
 * label (never a neutral "Continue"), the "machine downsizes now / no refund"
 * note, and no marketing tagline for the tier being stepped down to.
 */

import { describe, expect, test } from "bun:test";

import { packageSwitchCopy } from "./package-switch-copy";
import { PLAN_TIER_COPY } from "./plans-copy";

describe("packageSwitchCopy", () => {
  test("upgrade", () => {
    expect(packageSwitchCopy("upgrade", "Super", "super")).toEqual({
      title: "Upgrade to Super",
      subtitle: PLAN_TIER_COPY.super.tagline,
      priceCaption: "Billed monthly · prorated difference charged today",
      checklistHeading: "The plan includes",
      note: "",
      confirmLabel: "Continue",
      destructive: false,
    });
  });

  // A Custom sub can be net cheaper, so the caption names both outcomes rather
  // than claiming the difference settles today.
  test("switch", () => {
    expect(packageSwitchCopy("switch", "Ultra", "ultra")).toEqual({
      title: "Switch to Ultra",
      subtitle: PLAN_TIER_COPY.ultra.tagline,
      priceCaption:
        "Billed monthly · prorated difference charged today or credited next invoice",
      checklistHeading: "The plan includes",
      note: "",
      confirmLabel: "Continue",
      destructive: false,
    });
  });

  test("downgrade", () => {
    expect(packageSwitchCopy("downgrade", "Mighty", "mighty")).toEqual({
      title: "Downgrade to Mighty",
      subtitle: "",
      priceCaption: "Billed monthly · prorated credit on your next invoice",
      checklistHeading: "Your plan will include",
      note: "Your machine downsizes now and your storage stays. No refund.",
      confirmLabel: "Downgrade to Mighty",
      destructive: true,
    });
  });

  test("subtitle is empty for an unknown or absent tier key", () => {
    expect(
      packageSwitchCopy("upgrade", "Enterprise", "enterprise").subtitle,
    ).toBe("");
    expect(packageSwitchCopy("switch", "Custom", null).subtitle).toBe("");
  });
});
