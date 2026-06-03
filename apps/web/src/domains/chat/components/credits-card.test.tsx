/**
 * Tests for the presentational `CreditsCard`.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the click handlers with `fireEvent`. No jest-dom matchers — we
 * assert with plain bun `expect` against query results.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CreditsCard } from "./credits-card";

afterEach(() => {
  cleanup();
});

describe("CreditsCard", () => {
  test("renders the balance, coins icon, and fires onAddCredits when Add is clicked", () => {
    const onAddCredits = mock(() => {});
    const onEarnCredits = mock(() => {});

    const { getByText, getByRole, container } = render(
      <CreditsCard
        balance="60"
        onAddCredits={onAddCredits}
        onEarnCredits={onEarnCredits}
      />,
    );

    expect(getByText("60 credits")).toBeTruthy();
    // The Coins icon renders a lucide SVG; assert at least one is present.
    expect(container.querySelector("svg.lucide-coins")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: /add/i }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
    expect(onEarnCredits).not.toHaveBeenCalled();
  });

  test("hides only the credits pill when balance is null but still renders Earn Credits", () => {
    const { queryByText, getByText } = render(
      <CreditsCard
        balance={null}
        onAddCredits={() => {}}
        onEarnCredits={() => {}}
      />,
    );

    expect(queryByText(/credits$/)).toBeNull();
    expect(getByText("Earn Credits")).toBeTruthy();
  });

  test("fires onEarnCredits when the Earn Credits row is clicked", () => {
    const onEarnCredits = mock(() => {});

    const { getByText } = render(
      <CreditsCard
        balance="60"
        onAddCredits={() => {}}
        onEarnCredits={onEarnCredits}
      />,
    );

    fireEvent.click(getByText("Earn Credits"));
    expect(onEarnCredits).toHaveBeenCalledTimes(1);
  });
});
