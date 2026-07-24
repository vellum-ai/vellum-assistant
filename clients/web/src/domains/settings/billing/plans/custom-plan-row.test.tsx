/**
 * Rendering tests for CustomPlanRow's current-plan marker. `isCurrent` renders
 * the "Your Current Plan" tag, and `currentSummary` replaces the generic
 * descriptor with the sub's tier recap.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { CustomPlanRow } from "./custom-plan-row";

const GENERIC = "Select custom CPU power, Ram and Storage";

afterEach(() => {
  cleanup();
});

describe("CustomPlanRow", () => {
  test("shows the generic descriptor and no current tag by default", () => {
    const { queryByText } = render(<CustomPlanRow onConfigure={() => {}} />);
    expect(queryByText(/Select custom CPU power/)).not.toBeNull();
    expect(queryByText("Your Current Plan")).toBeNull();
  });

  test("renders the current-plan tag when isCurrent", () => {
    const { queryByText } = render(
      <CustomPlanRow onConfigure={() => {}} isCurrent />,
    );
    expect(queryByText("Your Current Plan")).not.toBeNull();
  });

  test("swaps the descriptor for the tier summary when provided", () => {
    const summary = "Medium machine · 30 GB · $50 credits";
    const { queryByText } = render(
      <CustomPlanRow
        onConfigure={() => {}}
        isCurrent
        currentSummary={summary}
      />,
    );
    expect(queryByText(summary)).not.toBeNull();
    // The generic copy is replaced, not shown alongside.
    expect(queryByText(new RegExp(GENERIC))).toBeNull();
  });
});
