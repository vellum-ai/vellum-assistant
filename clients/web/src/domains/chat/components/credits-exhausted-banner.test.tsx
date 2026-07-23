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
  test("add-credits mode renders exactly one Add Credits CTA and no Upgrade", () => {
    const onAddCredits = mock(() => {});
    const onUpgrade = mock(() => {});

    const { getAllByRole, getByRole, queryByRole, getByText } = render(
      <CreditsExhaustedBanner
        mode="add-credits"
        onAddCredits={onAddCredits}
        onUpgrade={onUpgrade}
      />,
    );

    expect(getByText(/Your balance has run out/)).toBeTruthy();
    expect(getAllByRole("button").length).toBe(1);
    expect(queryByRole("button", { name: "Upgrade" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add Credits" }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  test("upgrade mode renders exactly one Upgrade CTA and no Add Credits", () => {
    const onAddCredits = mock(() => {});
    const onUpgrade = mock(() => {});

    const { getAllByRole, getByRole, queryByRole, getByText } = render(
      <CreditsExhaustedBanner
        mode="upgrade"
        onAddCredits={onAddCredits}
        onUpgrade={onUpgrade}
      />,
    );

    expect(getByText(/Your balance has run out/)).toBeTruthy();
    expect(getAllByRole("button").length).toBe(1);
    expect(queryByRole("button", { name: "Add Credits" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Upgrade" }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onAddCredits).not.toHaveBeenCalled();
  });
});
