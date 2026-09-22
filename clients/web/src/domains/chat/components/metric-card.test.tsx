import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AnimatedMetricCard, formatNumber, MetricCard } from "./metric-card";

afterEach(cleanup);

describe("MetricCard", () => {
  // Usage tiles sit two or three to a row in the workflow and subagent panels,
  // where a compact count can be wider than its value box.
  test("shows a value in full, with no tooltip, when the caller gives none", () => {
    render(
      <AnimatedMetricCard
        icon={null}
        label="Input"
        target={257_400}
        format={formatNumber}
      />,
    );

    const row = screen.getByText("257.4K");
    expect(row.classList.contains("truncate")).toBe(false);
    expect(row.hasAttribute("title")).toBe(false);
  });

  test("truncates with room for descenders when the caller gives a tooltip", () => {
    render(
      <MetricCard icon={null} value="Opus" label="Model" valueTitle="Opus" />,
    );

    const row = screen.getByText("Opus");
    expect(row.getAttribute("title")).toBe("Opus");
    expect(row.classList.contains("truncate")).toBe(true);
    expect(row.classList.contains("pb-1")).toBe(true);
    expect(row.classList.contains("-mb-1")).toBe(true);
  });
});
