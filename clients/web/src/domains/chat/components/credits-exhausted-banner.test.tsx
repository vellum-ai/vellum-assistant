/**
 * Tests for `CreditsExhaustedBanner` — the two-CTA credit wall.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the CTAs with `fireEvent`. No jest-dom matchers — we assert with
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
  test("renders the title, subtitle, and both CTAs", () => {
    const { getByText, getByRole } = render(
      <CreditsExhaustedBanner onAddCredits={() => {}} onUpgrade={() => {}} />,
    );

    expect(getByText(/Your balance has run out/)).toBeTruthy();
    expect(
      getByText("Upgrade to a higher plan or add credits to continue."),
    ).toBeTruthy();
    expect(getByRole("button", { name: "Add Credits" })).toBeTruthy();
    expect(getByRole("button", { name: "Upgrade" })).toBeTruthy();
  });

  test("clicking Add Credits fires onAddCredits only", () => {
    const onAddCredits = mock(() => {});
    const onUpgrade = mock(() => {});

    const { getByRole } = render(
      <CreditsExhaustedBanner
        onAddCredits={onAddCredits}
        onUpgrade={onUpgrade}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Add Credits" }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  test("clicking Upgrade fires onUpgrade only", () => {
    const onAddCredits = mock(() => {});
    const onUpgrade = mock(() => {});

    const { getByRole } = render(
      <CreditsExhaustedBanner
        onAddCredits={onAddCredits}
        onUpgrade={onUpgrade}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Upgrade" }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onAddCredits).not.toHaveBeenCalled();
  });
});
