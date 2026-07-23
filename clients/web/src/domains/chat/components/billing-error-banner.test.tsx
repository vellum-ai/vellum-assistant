/**
 * Tests for the shared `BillingErrorBanner` primitive.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the CTAs with `fireEvent`. No jest-dom matchers — we assert with
 * plain bun `expect` against query results.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { BillingErrorBanner } from "./billing-error-banner";

afterEach(() => {
  cleanup();
});

describe("BillingErrorBanner", () => {
  test("renders a single primary CTA and its icon", () => {
    const onAction = mock(() => {});

    const { getAllByRole, getByText, getByTestId } = render(
      <BillingErrorBanner
        ariaLabel="Billing notice"
        icon={<span data-testid="banner-icon">!</span>}
        title="Title"
        subtitle="Subtitle"
        ctaLabel="Upgrade"
        onAction={onAction}
      />,
    );

    expect(getByText("Title")).toBeTruthy();
    expect(getByText("Subtitle")).toBeTruthy();
    expect(getByTestId("banner-icon")).toBeTruthy();

    const buttons = getAllByRole("button");
    expect(buttons.length).toBe(1);

    fireEvent.click(buttons[0]!);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("omits the icon column when no icon is provided", () => {
    const { getByText, queryByTestId } = render(
      <BillingErrorBanner
        ariaLabel="Billing notice"
        title="Title"
        subtitle="Subtitle"
        ctaLabel="Upgrade"
        onAction={() => {}}
      />,
    );

    expect(getByText("Title")).toBeTruthy();
    expect(queryByTestId("banner-icon")).toBeNull();
  });

  test("exposes role=status with the provided aria-label", () => {
    const { getByRole } = render(
      <BillingErrorBanner
        ariaLabel="Billing notice"
        title="Title"
        subtitle="Subtitle"
        ctaLabel="Upgrade"
        onAction={() => {}}
      />,
    );

    expect(getByRole("status", { name: "Billing notice" })).toBeTruthy();
  });
});
