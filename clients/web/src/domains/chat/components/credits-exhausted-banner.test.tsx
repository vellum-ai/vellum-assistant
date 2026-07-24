/**
 * Tests for the out-of-credits `CreditsExhaustedBanner`.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the CTA with `fireEvent`. No jest-dom matchers — we assert with
 * plain bun `expect` against query results.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CreditsExhaustedBanner } from "./credits-exhausted-banner";

afterEach(() => {
  cleanup();
});

describe("CreditsExhaustedBanner", () => {
  test("renders the title, subtitle, and an Upgrade CTA", () => {
    const { getByText, getByRole } = render(
      <CreditsExhaustedBanner onUpgrade={() => {}} />,
    );

    expect(getByText("Your credit balance has run out")).toBeTruthy();
    expect(
      getByText("Upgrade your plan for more credits every month."),
    ).toBeTruthy();
    expect(getByRole("button", { name: /upgrade/i })).toBeTruthy();
  });

  test("fires onUpgrade once when the CTA is clicked", () => {
    const onUpgrade = mock(() => {});

    const { getByRole } = render(
      <CreditsExhaustedBanner onUpgrade={onUpgrade} />,
    );

    fireEvent.click(getByRole("button", { name: /upgrade/i }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});
