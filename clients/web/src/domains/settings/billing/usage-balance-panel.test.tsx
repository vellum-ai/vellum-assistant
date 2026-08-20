/**
 * Tests for the Plan tile's usage-balance footer.
 *
 * The panel is presentational: the caller decides whether the bundle counts as
 * exhausted (spent to 100% *and* the wallet behind it empty), and the panel
 * turns the reading negative and raises the add-credits strip when it does.
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

  test("a spent bundle with credits left still reads neutral", () => {
    // `exhausted` is the wallet's state, not the bar's: at 100% with credits
    // still in hand the caller leaves it off and nothing turns red.
    const { getByTestId, queryByTestId } = render(
      <UsageBalancePanel ratio={1} resetsAt={RESETS_AT} />,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(panel.textContent).toContain("100% used");
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
});
