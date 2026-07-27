/**
 * Tests for `CreditsExhaustedBanner` — the single-CTA credit wall gated by mode.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the CTA with `fireEvent`. No jest-dom matchers — we assert with
 * plain bun `expect` against query results. The title carries an inline emoji,
 * so it is matched with a regex that tolerates the prefix.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CreditsExhaustedBanner } from "./credits-exhausted-banner";

afterEach(() => {
  cleanup();
});

describe("CreditsExhaustedBanner", () => {
  test("add-credits-free mode renders exactly one Add credits CTA and no View plans", () => {
    const onAddCredits = mock(() => {});
    const onUpgrade = mock(() => {});

    const { getAllByRole, getByRole, queryByRole, getByText } = render(
      <CreditsExhaustedBanner
        mode="add-credits-free"
        onAddCredits={onAddCredits}
        onUpgrade={onUpgrade}
      />,
    );

    expect(getByText(/You’ve used all your credits/)).toBeTruthy();
    expect(
      getByText("Add credits to continue without changing your plan."),
    ).toBeTruthy();
    expect(getAllByRole("button").length).toBe(1);
    expect(queryByRole("button", { name: "View plans" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  test("add-credits-paid mode renders exactly one Add credits CTA and no View plans", () => {
    const onAddCredits = mock(() => {});
    const onUpgrade = mock(() => {});

    const { getAllByRole, getByRole, queryByRole, getByText } = render(
      <CreditsExhaustedBanner
        mode="add-credits-paid"
        onAddCredits={onAddCredits}
        onUpgrade={onUpgrade}
      />,
    );

    expect(getByText(/You’ve used all your credits/)).toBeTruthy();
    expect(getByText("Add more credits to keep going.")).toBeTruthy();
    expect(getAllByRole("button").length).toBe(1);
    expect(queryByRole("button", { name: "View plans" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  test("upgrade mode renders exactly one View plans CTA and no Add credits", () => {
    const onAddCredits = mock(() => {});
    const onUpgrade = mock(() => {});

    const { getAllByRole, getByRole, queryByRole, getByText } = render(
      <CreditsExhaustedBanner
        mode="upgrade"
        onAddCredits={onAddCredits}
        onUpgrade={onUpgrade}
      />,
    );

    expect(getByText(/You’ve used all your Free credits/)).toBeTruthy();
    expect(getByText("Upgrade to a higher plan to continue.")).toBeTruthy();
    expect(getAllByRole("button").length).toBe(1);
    expect(queryByRole("button", { name: "Add credits" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "View plans" }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onAddCredits).not.toHaveBeenCalled();
  });
});
