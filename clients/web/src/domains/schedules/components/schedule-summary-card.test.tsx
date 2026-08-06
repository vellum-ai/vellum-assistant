/**
 * Tests for the presentational ScheduleSummaryCard shell:
 *  - Collapsed renders title/subtitle/costLabel and hides children; clicking the
 *    card toggles expand.
 *  - Expanded renders children and a minimize button; clicking minimize toggles.
 *  - Cost loading renders a skeleton; cost error renders an em dash.
 *
 * Uses @testing-library/react (happy-dom is registered via the test preload) so
 * we can drive clicks and assert presence/absence of body content.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ScheduleSummaryCard } from "./schedule-summary-card";

afterEach(cleanup);

const BASE_PROPS = {
  title: "Schedules",
  subtitle: "3 active",
  costLabel: "$4.29",
  costStatus: "ready" as const,
  isExpanded: false,
  onToggleExpand: () => {},
};

describe("ScheduleSummaryCard", () => {
  test("collapsed renders title/subtitle/costLabel and hides children", () => {
    const { getByText, queryByText } = render(
      <ScheduleSummaryCard {...BASE_PROPS}>
        <div>hidden child</div>
      </ScheduleSummaryCard>,
    );

    expect(getByText("Schedules")).toBeTruthy();
    expect(getByText("3 active")).toBeTruthy();
    expect(getByText("$4.29")).toBeTruthy();
    expect(queryByText("hidden child")).toBeNull();
  });

  test("collapsed renders an Expand affordance", () => {
    const { getByText } = render(<ScheduleSummaryCard {...BASE_PROPS} />);
    expect(getByText("Expand")).toBeTruthy();
  });

  test("clicking the collapsed card calls onToggleExpand", () => {
    const onToggleExpand = mock(() => {});
    const { getByRole } = render(
      <ScheduleSummaryCard {...BASE_PROPS} onToggleExpand={onToggleExpand} />,
    );

    fireEvent.click(getByRole("button"));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  test("collapsed loading cost renders a skeleton, not the cost label", () => {
    const { getByLabelText, queryByText } = render(
      <ScheduleSummaryCard {...BASE_PROPS} costStatus="loading" />,
    );

    expect(getByLabelText("Loading cost")).toBeTruthy();
    expect(queryByText("$4.29")).toBeNull();
  });

  test("collapsed error cost renders an em dash", () => {
    const { getByText, queryByText } = render(
      <ScheduleSummaryCard {...BASE_PROPS} costStatus="error" />,
    );

    expect(getByText("—")).toBeTruthy();
    expect(queryByText("$4.29")).toBeNull();
  });

  test("expanded renders children and a minimize button", () => {
    const { getByText, getByLabelText } = render(
      <ScheduleSummaryCard {...BASE_PROPS} isExpanded>
        <div>visible child</div>
      </ScheduleSummaryCard>,
    );

    expect(getByText("visible child")).toBeTruthy();
    expect(getByLabelText("Minimize Schedules")).toBeTruthy();
  });

  test("clicking minimize calls onToggleExpand", () => {
    const onToggleExpand = mock(() => {});
    const { getByLabelText } = render(
      <ScheduleSummaryCard
        {...BASE_PROPS}
        isExpanded
        onToggleExpand={onToggleExpand}
      >
        <div>visible child</div>
      </ScheduleSummaryCard>,
    );

    fireEvent.click(getByLabelText("Minimize Schedules"));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });
});
