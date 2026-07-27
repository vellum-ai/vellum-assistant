/**
 * Unit tests for the relation-keyed package-switch confirm copy.
 *
 * The three `toEqual` cases pin every field of every relation, so the extra
 * tests below only earn their place by covering inputs those three don't:
 * an unknown tier key, and the same tier key read across two relations.
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

  test("a downgrade withholds the tagline the same tier gets on the way up", () => {
    // The tagline is a pitch. Under "Downgrade to Mighty" it sells the tier the
    // user is leaving, so only the upward directions may quote it.
    expect(packageSwitchCopy("downgrade", "Mighty", "mighty").subtitle).toBe(
      "",
    );
    expect(packageSwitchCopy("upgrade", "Mighty", "mighty").subtitle).toBe(
      PLAN_TIER_COPY.mighty.tagline,
    );
    expect(packageSwitchCopy("switch", "Mighty", "mighty").subtitle).toBe(
      PLAN_TIER_COPY.mighty.tagline,
    );
  });

  test("subtitle is empty for an unknown or absent tier key", () => {
    expect(
      packageSwitchCopy("upgrade", "Enterprise", "enterprise").subtitle,
    ).toBe("");
    expect(packageSwitchCopy("switch", "Custom", null).subtitle).toBe("");
  });
});
