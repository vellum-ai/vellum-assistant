/**
 * Tests for the Plan tile's usage-balance footer.
 *
 * A reading is presentational, and the two states it draws are independent.
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
import { UsageBalanceReading } from "./usage-balance-reading";

afterEach(() => {
  cleanup();
});

/** Local noon, so the printed calendar day holds whatever the host offset is. */
const SEP_20 = new Date(2026, 8, 20, 12).toISOString();

describe("UsageBalancePanel", () => {
  test("draws a neutral reading below 100%", () => {
    const { getByTestId, queryByTestId, queryByText } = render(
      <UsageBalancePanel>
        <UsageBalanceReading ratio={0.4} title="Overall Usage" />
      </UsageBalancePanel>,
    );

    const panel = getByTestId("plan-usage-balance");
    expect(panel.textContent).toContain("Overall Usage");
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

  test("two readings share the one panel, the first above the second", () => {
    const { getByTestId } = render(
      <UsageBalancePanel>
        <UsageBalanceReading
          ratio={0.4}
          title="Daily Usage"
          testId="plan-daily-usage"
        />
        <UsageBalanceReading ratio={0.2} title="Overall Usage" />
      </UsageBalancePanel>,
    );

    const panel = getByTestId("plan-usage-panel");
    const daily = getByTestId("plan-daily-usage");
    const overall = getByTestId("plan-usage-balance");
    expect(daily.parentElement).toBe(panel);
    expect(overall.parentElement).toBe(panel);
    // Label, bar, and percentage are each a cell on the panel's columns, so
    // a wider percentage on one row cannot shorten that row's bar alone.
    for (const row of [daily, overall]) {
      const bar = row.querySelector('[data-slot="progress-bar"]');
      expect(bar?.parentElement).toBe(row);
      expect(bar?.nextElementSibling?.parentElement).toBe(row);
      expect(bar?.nextElementSibling?.textContent).toMatch(/% used$/);
    }
    expect(
      daily.compareDocumentPosition(overall) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("wording overrides give a second reading its own line, label, strip, and ids", () => {
    const { getByRole, getByTestId, getByText, queryByTestId } = render(
      <UsageBalancePanel>
        <UsageBalanceReading
          ratio={1}
          exhausted
          title="Daily Usage"
          line="Resets at 5:00 PM"
          barLabel="Daily Usage, resets at 5:00 PM"
          exhaustedMessage="You've used today's free usage"
          testId="plan-daily-usage"
          lineTestId="plan-daily-usage-resets"
        />
      </UsageBalancePanel>,
    );

    const panel = getByTestId("plan-daily-usage");
    expect(panel.textContent).toContain("Daily Usage");
    expect(panel.textContent).toContain("100% used");
    expect(getByTestId("plan-daily-usage-resets").textContent).toBe(
      "Resets at 5:00 PM",
    );
    expect(getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Daily Usage, resets at 5:00 PM",
    );
    expect(getByText("You've used today's free usage")).toBeTruthy();
    // The default ids belong to the overall reading alone.
    expect(queryByTestId("plan-usage-balance")).toBeNull();
    expect(queryByTestId("plan-usage-period-end")).toBeNull();
  });

  test("prints the reset date under the title for a bundled subscription", () => {
    const { getByRole, getByTestId } = render(
      <UsageBalancePanel>
        <UsageBalanceReading
          ratio={0.4}
          title="Monthly Usage"
          periodEnd={{ at: SEP_20, kind: "resets" }}
        />
      </UsageBalancePanel>,
    );

    expect(getByTestId("plan-usage-period-end").textContent).toBe(
      "Resets on Sep 20",
    );
    // The bar's accessible name is its own complete message, not the title and
    // the date line stitched together.
    expect(getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Monthly Usage, resets on Sep 20",
    );
  });

  test("names the date a renewal for a subscription with no bundle", () => {
    const { getByRole, getByTestId } = render(
      <UsageBalancePanel>
        <UsageBalanceReading
          ratio={0.4}
          title="Monthly Usage"
          periodEnd={{ at: SEP_20, kind: "renews" }}
        />
      </UsageBalancePanel>,
    );

    expect(getByTestId("plan-usage-period-end").textContent).toBe(
      "Renews on Sep 20",
    );
    expect(getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Monthly Usage, renews on Sep 20",
    );
  });

  test("prints no date line for an instant that will not parse", () => {
    const { getByRole, queryByTestId } = render(
      <UsageBalancePanel>
        <UsageBalanceReading
          ratio={0.4}
          title="Monthly Usage"
          periodEnd={{ at: "not-a-date", kind: "resets" }}
        />
      </UsageBalancePanel>,
    );

    expect(queryByTestId("plan-usage-period-end")).toBeNull();
    expect(getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Monthly Usage",
    );
  });

  test("used-up grants turn negative with credits still in hand", () => {
    // The caller leaves `exhausted` off while the wallet has something left,
    // so the reading goes red on its own and no strip appears.
    const { getByTestId, queryByTestId, getByText, queryByText } = render(
      <UsageBalancePanel>
        <UsageBalanceReading ratio={1} title="Overall Usage" />
      </UsageBalancePanel>,
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
      <UsageBalancePanel>
        <UsageBalanceReading ratio={1} title="Overall Usage" exhausted />
      </UsageBalancePanel>,
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
      <UsageBalancePanel>
        <UsageBalanceReading
          ratio={1}
          title="Overall Usage"
          exhausted
          onAddCredits={onAddCredits}
        />
      </UsageBalancePanel>,
    );

    fireEvent.click(getByTestId("plan-usage-add-credits"));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });
});
