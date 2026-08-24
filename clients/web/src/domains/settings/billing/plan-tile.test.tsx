/**
 * Tests for PlanTile: the shared tile of the billing "Plan" section. Verifies
 * it renders the tag, the 48px avatar slot, the name (forwarding `nameTestId`),
 * the spec-chip stack and the footer slot; splits the wrapped layout into the
 * wrapping row and the chips that asked for a row of their own; drops the chip
 * stack for null and empty `specs` and the footer wrapper when no footer is
 * passed; stamps a nested `data-theme` scope only when `theme` is set; and
 * forwards `testId` and `className` to the root.
 *
 * The lazy `PlanTierAvatar` compositor bundle is mocked away so the avatar
 * renders its deterministic same-size placeholder (mirrors
 * plan-spec-card.test.tsx).
 */

import { Coins, Computer, HardDrive, Mail } from "lucide-react";

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

/** The production shape under `obscure-credits`: two short chips, two rows. */
const OWN_ROW_SPECS: PlanSpec[] = [
  { icon: Computer, label: "Small Machine" },
  { icon: HardDrive, label: "10 GB Storage" },
  { icon: Coins, label: "Mighty usage, reset monthly", ownRow: true },
  { icon: Mail, label: "Assistant email and subdomain", ownRow: true },
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

  test("stacks the chips vertically by default", () => {
    const { getByTestId } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="mighty"
        name="Mighty"
        tag={<span>Current</span>}
        specs={SPECS}
      />,
    );

    // Child 0 is the header row; child 1 is the chip container.
    const container = getByTestId(TILE_TEST_ID).children[1] as HTMLElement;
    expect(container.className).toContain("flex-col");
    expect(container.className).not.toContain("flex-wrap");
  });

  test("lays the chips out as a wrapping row when specsWrap is set", () => {
    const { getByTestId } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="mighty"
        name="Mighty"
        tag={<span>Current</span>}
        specs={SPECS}
        specsWrap
      />,
    );

    // No spec asks for its own row, so the whole set flows in the one wrap row.
    const container = getByTestId(TILE_TEST_ID).children[1] as HTMLElement;
    expect(container.className).toContain("flex-col");
    expect(container.childElementCount).toBe(1);
    const wrapRow = container.firstElementChild as HTMLElement;
    expect(wrapRow.className).toContain("flex-row");
    expect(wrapRow.className).toContain("flex-wrap");
    expect(wrapRow.childElementCount).toBe(SPECS.length);
  });

  test("gives an ownRow spec a full row below the wrapping group", () => {
    const { getByTestId, getByText } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="mighty"
        name="Mighty"
        tag={<span>Current</span>}
        specs={OWN_ROW_SPECS}
        specsWrap
      />,
    );

    const container = getByTestId(TILE_TEST_ID).children[1] as HTMLElement;
    // The wrap row, then one block per own-row spec.
    expect(container.childElementCount).toBe(3);
    const wrapRow = container.firstElementChild as HTMLElement;
    expect(wrapRow.className).toContain("flex-wrap");
    expect(wrapRow.childElementCount).toBe(2);
    expect(wrapRow.textContent).toContain("Small Machine");
    expect(wrapRow.textContent).toContain("10 GB Storage");
    expect(container.children[1]?.textContent).toBe(
      "Mighty usage, reset monthly",
    );
    expect(container.children[2]?.textContent).toBe(
      "Assistant email and subdomain",
    );
    // A full-width row can afford to wrap a long label inside the pill.
    expect(getByText("Mighty usage, reset monthly").className).toContain(
      "whitespace-normal",
    );
  });

  test("renders no empty wrap group when every spec takes its own row", () => {
    const { getByTestId } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="mighty"
        name="Mighty"
        tag={<span>Current</span>}
        specs={OWN_ROW_SPECS.filter((spec) => spec.ownRow)}
        specsWrap
      />,
    );

    const container = getByTestId(TILE_TEST_ID).children[1] as HTMLElement;
    expect(container.childElementCount).toBe(2);
    expect(container.firstElementChild?.className).not.toContain("flex-wrap");
  });

  test("ignores ownRow in the vertical stack", () => {
    const { getByTestId, getByText } = render(
      <PlanTile
        testId={TILE_TEST_ID}
        tierKey="mighty"
        name="Mighty"
        tag={<span>Current</span>}
        specs={OWN_ROW_SPECS}
      />,
    );

    // Every chip already has a row of its own, in the order it was given.
    const container = getByTestId(TILE_TEST_ID).children[1] as HTMLElement;
    expect(container.childElementCount).toBe(OWN_ROW_SPECS.length);
    expect(container.className).toContain("flex-col");
    expect(getByText("Mighty usage, reset monthly").className).toContain(
      "whitespace-nowrap",
    );
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
