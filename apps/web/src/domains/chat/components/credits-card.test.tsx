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

    const { getByText, getByRole, container } = render(
      <CreditsCard balance="60" onAddCredits={onAddCredits} />,
    );

    expect(getByText("60 credits")).toBeTruthy();
    // The Coins icon renders a lucide SVG; assert at least one is present.
    expect(container.querySelector("svg.lucide-coins")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: /add/i }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });

  test("hides the credits pill when balance is null and renders without errors", () => {
    const { queryByText } = render(
      <CreditsCard balance={null} onAddCredits={() => {}} />,
    );

    expect(queryByText(/credits$/)).toBeNull();
  });
});
