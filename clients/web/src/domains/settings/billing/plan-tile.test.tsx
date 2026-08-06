/**
 * Tests for PlanTile: the shared tile of the billing "Plan" section. Verifies
 * it renders the tag, the 48px avatar slot, the name (forwarding `nameTestId`),
 * the spec-chip stack and the footer slot; drops the chip stack for null and
 * empty `specs` and the footer wrapper when no footer is passed; stamps a
 * nested `data-theme` scope only when `theme` is set; and forwards `testId`
 * and `className` to the root.
 *
 * The lazy `PlanTierAvatar` compositor bundle is mocked away so the avatar
 * renders its deterministic same-size placeholder (mirrors
 * plan-spec-card.test.tsx).
 */

import { Coins, Computer, HardDrive } from "lucide-react";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import type { PlanSpec } from "@/domains/settings/billing/plan-spec";

// Render avatar placeholders; skip the lazy compositor bundle.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

const { PlanTile } = await import("./plan-tile");

const SPECS: PlanSpec[] = [
  { icon: Computer, label: "Small Machine" },
  { icon: HardDrive, label: "10 GB Storage" },
  { icon: Coins, label: "$25 in credits included" },
];

const TILE_TEST_ID = "plan-tile";

afterEach(() => {
  cleanup();
});

describe("PlanTile", () => {
  test("renders the tag, avatar, name, spec chips, and footer", () => {
    const { getByTestId, getByText } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="mighty"
        name="Mighty"
        nameTestId="plan-tile-name"
        tag={<span data-testid="plan-tile-tag">Current</span>}
        specs={SPECS}
        footer={<span data-testid="plan-tile-footer">$30/month</span>}
      />,
    );

    expect(getByTestId("plan-tile-tag").textContent).toBe("Current");
    expect(getByTestId("plan-tile-name").textContent).toBe("Mighty");
    expect(getByTestId("plan-tile-footer").textContent).toBe("$30/month");
    for (const spec of SPECS) {
      expect(getByText(spec.label)).toBeTruthy();
    }

    // The avatar is decorative and holds a 48px box until the creature bundle
    // resolves; the spec-chip icons are svgs, so this selects only the avatar.
    const avatar = getByTestId(TILE_TEST_ID).querySelector("div[aria-hidden]");
    const placeholder = avatar?.firstElementChild as HTMLElement | null;
    expect(placeholder?.style.width).toBe("48px");
    expect(placeholder?.style.height).toBe("48px");
  });

  test("omits the chip stack when specs is null", () => {
    const { getByTestId, queryByText } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="free"
        name="Free"
        tag={<span>Current</span>}
        specs={null}
        footer={<span>Free Forever</span>}
      />,
    );

    for (const spec of SPECS) {
      expect(queryByText(spec.label)).toBeNull();
    }
    // Header row and footer only: no chip-stack wrapper in between.
    expect(getByTestId(TILE_TEST_ID).childElementCount).toBe(2);
  });

  test("omits the chip stack when specs is empty", () => {
    const { getByTestId, queryByText } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="free"
        name="Free"
        tag={<span>Current</span>}
        specs={[]}
        footer={<span>Free Forever</span>}
      />,
    );

    for (const spec of SPECS) {
      expect(queryByText(spec.label)).toBeNull();
    }
    expect(getByTestId(TILE_TEST_ID).childElementCount).toBe(2);
  });

  test("renders no footer wrapper when footer is omitted", () => {
    const { getByTestId } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="mighty"
        name="Mighty"
        tag={<span>Current</span>}
        specs={SPECS}
      />,
    );

    const root = getByTestId(TILE_TEST_ID);
    // Header row and chip stack only, and the last child is the chip stack
    // rather than an empty footer slot.
    expect(root.childElementCount).toBe(2);
    expect(root.lastElementChild?.textContent).toContain("Small Machine");
  });

  test("renders only the header row with no specs and no footer", () => {
    const { getByTestId } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="custom"
        name="Custom"
        tag={<span>Current</span>}
      />,
    );

    expect(getByTestId(TILE_TEST_ID).childElementCount).toBe(1);
  });

  test("stamps a nested data-theme scope when theme is set", () => {
    const { getByTestId } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        theme="dark"
        tierKey="super"
        name="Super"
        tag={<span>Next Plan</span>}
        specs={SPECS}
      />,
    );

    expect(getByTestId(TILE_TEST_ID).getAttribute("data-theme")).toBe("dark");
  });

  test("leaves no data-theme attribute when theme is omitted", () => {
    const { getByTestId } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="free"
        name="Free"
        tag={<span>Current</span>}
        specs={SPECS}
      />,
    );

    expect(getByTestId(TILE_TEST_ID).hasAttribute("data-theme")).toBe(false);
  });

  test("forwards testId and className to the root", () => {
    const { getByTestId } = render(
      <PlanTile
        testId="current-plan-tile"
        className="lg:flex-[3]"
        tierKey="free"
        name="Free"
        tag={<span>Current</span>}
      />,
    );

    const root = getByTestId("current-plan-tile");
    expect(root.classList.contains("lg:flex-[3]")).toBe(true);
  });
});
