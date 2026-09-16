/**
 * Tests for the Plan tile's usage-balance footer.
 *
 * The panel is presentational, and the two readings it draws are independent.
 * The bar and the percentage turn negative off `ratio` alone, the moment the
 * granted credit is used up. The add-credits strip waits on `exhausted`, which
 * the caller sets only once the wallet behind the grants is empty too.
 *
 * The date line under the title is a third independent reading: it appears
 * only when the caller hands over a `periodEnd`, and its wording follows
 * `periodEnd.kind`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { UsageBalancePanel } from "./usage-balance-panel";

afterEach(() => {
  cleanup();
});

/** Local noon, so the printed calendar day holds whatever the host offset is. */
const SEP_20 = new Date(2026, 8, 20, 12).toISOString();

describe("UsageBalancePanel", () => {
  test("draws a neutral reading below 100%", () => {
    const { getByTestId, queryByTestId, queryByText } = render(
      <UsageBalancePanel ratio={0.4} />,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(panel.textContent).toContain("40% used");
    expect(queryByTestId("plan-usage-period-end")).toBeNull();
    expect(
      queryByText("Add credits to continue using your assistant"),
    ).toBeNull();
    expect(queryByTestId("plan-usage-add-credits")).toBeNull();
    const fill = panel.querySelector('[data-slot="progress-bar-fill"]');
    expect(fill?.getAttribute("style")).not.toContain(
      "--system-negative-strong",
    );
  });

  test("prints the reset date under the title for a bundled subscription", () => {
    const { getByRole, getByTestId } = render(
      <UsageBalancePanel
        ratio={0.4}
        periodEnd={{ at: SEP_20, kind: "resets" }}
      />,
    );

    expect(getByTestId("plan-usage-period-end").textContent).toBe(
      "Resets on Sep 20",
    );
    // The bar's accessible name is its own complete message, not the title and
    // the date line stitched together.
    expect(getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Current Usage, resets on Sep 20",
    );
  });

  test("names the date a renewal for a subscription with no bundle", () => {
    const { getByRole, getByTestId } = render(
      <UsageBalancePanel
        ratio={0.4}
        periodEnd={{ at: SEP_20, kind: "renews" }}
      />,
    );

    expect(getByTestId("plan-usage-period-end").textContent).toBe(
      "Renews on Sep 20",
    );
    expect(getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Current Usage, renews on Sep 20",
    );
  });

  test("prints no date line for an instant that will not parse", () => {
    const { getByRole, queryByTestId } = render(
      <UsageBalancePanel
        ratio={0.4}
        periodEnd={{ at: "not-a-date", kind: "resets" }}
      />,
    );

    expect(queryByTestId("plan-usage-period-end")).toBeNull();
    expect(getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Current Usage",
    );
  });

  test("used-up grants turn negative with credits still in hand", () => {
    // The caller leaves `exhausted` off while the wallet has something left,
    // so the reading goes red on its own and no strip appears.
    const { getByTestId, queryByTestId, getByText, queryByText } = render(
      <UsageBalancePanel ratio={1} />,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(panel.textContent).toContain("100% used");
    const fill = panel.querySelector('[data-slot="progress-bar-fill"]');
    expect(fill?.getAttribute("style")).toContain("--system-negative-strong");
    expect(getByText("100% used").className).toContain(
      "--system-negative-strong",
    );
    expect(
      queryByText("Add credits to continue using your assistant"),
    ).toBeNull();
    expect(queryByTestId("plan-usage-add-credits")).toBeNull();
  });

  test("an exhausted balance turns negative and raises the strip", () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <UsageBalancePanel ratio={1} exhausted />,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(
      getByText("Add credits to continue using your assistant"),
    ).toBeTruthy();
    const fill = panel.querySelector('[data-slot="progress-bar-fill"]');
    expect(fill?.getAttribute("style")).toContain("--system-negative-strong");
    const pct = getByText("100% used");
    expect(pct.className).toContain("--system-negative-strong");
    // No handler here, so there is nothing to click, but the reason the
    // assistant stopped still has to be readable.
    expect(queryByTestId("plan-usage-add-credits")).toBeNull();
  });

  test("the strip's Add button opens the caller's checkout", () => {
    const onAddCredits = mock(() => {});
    const { getByTestId } = render(
      <UsageBalancePanel ratio={1} exhausted onAddCredits={onAddCredits} />,
    );

    fireEvent.click(getByTestId("plan-usage-add-credits"));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });
});
