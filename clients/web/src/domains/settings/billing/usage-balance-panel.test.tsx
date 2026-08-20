/**
 * Tests for the Plan tile's usage-balance footer.
 *
 * The panel is presentational, and the two readings it draws are independent.
 * The bar and the percentage turn negative off `ratio` alone, the moment the
 * included bundle is spent. The add-credits strip waits on `exhausted`, which
 * the caller sets only once the wallet behind that bundle is empty too.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { UsageBalancePanel } from "./usage-balance-panel";

const RESETS_AT = "2026-08-10T00:00:00Z";

afterEach(() => {
  cleanup();
});

describe("UsageBalancePanel", () => {
  test("draws a neutral reading below 100%", () => {
    const { getByTestId, queryByTestId, queryByText } = render(
      <UsageBalancePanel ratio={0.4} resetsAt={RESETS_AT} />,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(panel.textContent).toContain("40% used");
    expect(
      queryByText("Add credits to continue using your assistant"),
    ).toBeNull();
    expect(queryByTestId("plan-usage-add-credits")).toBeNull();
    const fill = panel.querySelector('[data-slot="progress-bar-fill"]');
    expect(fill?.getAttribute("style")).not.toContain(
      "--system-negative-strong",
    );
  });

  test("a spent bundle turns negative with credits still in hand", () => {
    // The caller leaves `exhausted` off while the wallet has something left,
    // so the reading goes red on its own and no strip appears.
    const { getByTestId, queryByTestId, getByText, queryByText } = render(
      <UsageBalancePanel ratio={1} resetsAt={RESETS_AT} />,
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
    const { getByTestId, getByText } = render(
      <UsageBalancePanel ratio={1} resetsAt={RESETS_AT} exhausted />,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(
      getByText("Add credits to continue using your assistant"),
    ).toBeTruthy();
    const fill = panel.querySelector('[data-slot="progress-bar-fill"]');
    expect(fill?.getAttribute("style")).toContain("--system-negative-strong");
    const pct = getByText("100% used");
    expect(pct.className).toContain("--system-negative-strong");
  });

  test("the strip's Add button opens the caller's checkout", () => {
    const onAddCredits = mock(() => {});
    const { getByTestId } = render(
      <UsageBalancePanel
        ratio={1}
        resetsAt={RESETS_AT}
        exhausted
        onAddCredits={onAddCredits}
      />,
    );

    fireEvent.click(getByTestId("plan-usage-add-credits"));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });

  test("states the case without an action when no handler is given", () => {
    // Nothing to click, but the reason the assistant stopped still has to be
    // readable.
    const { getByText, queryByTestId } = render(
      <UsageBalancePanel ratio={1} resetsAt={RESETS_AT} exhausted />,
    );

    expect(
      getByText("Add credits to continue using your assistant"),
    ).toBeTruthy();
    expect(queryByTestId("plan-usage-add-credits")).toBeNull();
  });

  test("a wallet reading quotes no reset date", () => {
    // A free plan's usage grant is not a cycle, so there is nothing to say
    // about when they come back.
    const { getByTestId } = render(
      <UsageBalancePanel ratio={0.68} resetsAt={null} />,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(panel.textContent).toContain("68% used");
    expect(panel.textContent).not.toContain("Resets");
  });
});
