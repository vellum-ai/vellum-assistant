/**
 * Unit tests for the relation-keyed package-switch confirm copy.
 *
 * The downgrade variant carries the safeguards: an explicit destructive CTA
 * label (never a neutral "Continue") and the "machine downsizes now / no
 * refund" note.
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
      subtitle: PLAN_TIER_COPY.mighty.tagline,
      priceCaption: "Billed monthly · prorated credit on your next invoice",
      checklistHeading: "Your plan will include",
      note: "Your machine downsizes now and your storage stays. No refund.",
      confirmLabel: "Downgrade to Mighty",
      destructive: true,
    });
  });

  test("the neutral switch caption keeps the next-invoice credit path", () => {
    // A Custom sub can be net cheaper, so the caption must not claim the
    // difference settles today.
    const { priceCaption } = packageSwitchCopy("switch", "Custom", null);
    expect(priceCaption).toContain("charged today");
    expect(priceCaption).toContain("credited next invoice");
    expect(priceCaption).not.toContain("settled today");
  });

  test("only a downgrade is destructive", () => {
    expect(packageSwitchCopy("downgrade", "Mighty", "mighty").destructive).toBe(
      true,
    );
    expect(packageSwitchCopy("upgrade", "Mighty", "mighty").destructive).toBe(
      false,
    );
    expect(packageSwitchCopy("switch", "Mighty", "mighty").destructive).toBe(
      false,
    );
  });

  test("the downgrade confirm label stays explicit", () => {
    const { confirmLabel } = packageSwitchCopy("downgrade", "Mighty", "mighty");
    expect(confirmLabel).toBe("Downgrade to Mighty");
    expect(confirmLabel).not.toBe("Continue");
  });

  test("only a downgrade carries the safeguard note", () => {
    expect(packageSwitchCopy("downgrade", "Mighty", "mighty").note).toContain(
      "No refund",
    );
    expect(packageSwitchCopy("upgrade", "Mighty", "mighty").note).toBe("");
    expect(packageSwitchCopy("switch", "Mighty", "mighty").note).toBe("");
  });

  test("only a downgrade frames the checklist as what is left", () => {
    expect(
      packageSwitchCopy("downgrade", "Mighty", "mighty").checklistHeading,
    ).toBe("Your plan will include");
    expect(
      packageSwitchCopy("upgrade", "Mighty", "mighty").checklistHeading,
    ).toBe("The plan includes");
    expect(
      packageSwitchCopy("switch", "Mighty", "mighty").checklistHeading,
    ).toBe("The plan includes");
  });

  test("subtitle is empty for an unknown or absent tier key", () => {
    expect(
      packageSwitchCopy("upgrade", "Enterprise", "enterprise").subtitle,
    ).toBe("");
    expect(packageSwitchCopy("switch", "Custom", null).subtitle).toBe("");
  });
});
