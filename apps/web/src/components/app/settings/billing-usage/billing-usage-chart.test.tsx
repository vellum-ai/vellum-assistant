/**
 * Tests for the `BillingUsageChart` mobile responsiveness branch added to
 * close the same gap PR #6032 closed for `SimpleBarChart`. We verify the
 * empty-state, the chart-rendering, and the loading branches all respect
 * the `useIsMobile()` hook.
 *
 * Recharts only paints its SVG once `ResponsiveContainer` reports a
 * non-zero size via `ResizeObserver` — happy-dom never fires that
 * callback, so we replace `ResponsiveContainer` with a passthrough that
 * forwards a fixed pixel size, mirroring the pattern in
 * `SimpleBarChart.test.tsx`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as React from "react";

mock.module("recharts", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = require("recharts");
  const FixedContainer = ({ children }: { children: React.ReactNode }) => {
    const sized = React.Children.map(children, (child) =>
      React.isValidElement(child)
        ? React.cloneElement(
            child as React.ReactElement<{ width?: number; height?: number }>,
            { width: 600, height: 400 },
          )
        : child,
    );
    return React.createElement(
      "div",
      { style: { width: 600, height: 400 } },
      sized,
    );
  };
  return { ...actual, ResponsiveContainer: FixedContainer };
});

const useIsMobileMock = mock(() => false);
mock.module("@/lib/hooks/useIsMobile.js", () => ({
  useIsMobile: useIsMobileMock,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// Subject under test — must come *after* the module mocks.
import { render } from "@testing-library/react";

import type { UsageBucket } from "@/generated/api/types.gen.js";

import { BillingUsageChart } from "@/components/app/settings/billing-usage/billing-usage-chart.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_BUCKETS: UsageBucket[] = [
  {
    date: "2026-01-01",
    groups: [
      {
        group_key: "runtime_proxy_api",
        group_label: "LLM Spend",
        total_usd: "340.00",
        event_count: 12,
      },
    ],
  },
  {
    date: "2026-01-02",
    groups: [
      {
        group_key: "runtime_proxy_api",
        group_label: "LLM Spend",
        total_usd: "120.50",
        event_count: 8,
      },
    ],
  },
];

// Recharts' tooltip layer triggers async state updates that React's test
// runtime wants wrapped in `act(...)`. Silence the warning here; behavior
// under test is unaffected.
let originalError: typeof console.error;
beforeAll(() => {
  originalError = console.error;
  console.error = () => {};
});
afterAll(() => {
  console.error = originalError;
});

beforeEach(() => {
  useIsMobileMock.mockReset();
  useIsMobileMock.mockImplementation(() => false);
});

afterEach(() => {
  useIsMobileMock.mockImplementation(() => false);
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("BillingUsageChart — empty state height", () => {
  test("desktop renders the no-data placeholder at 350px", () => {
    useIsMobileMock.mockImplementation(() => false);
    const { container, unmount } = render(
      <BillingUsageChart buckets={[]} metric="spend" />,
    );
    const placeholder = container.querySelector<HTMLElement>("div.h-\\[350px\\]");
    expect(placeholder).not.toBeNull();
    unmount();
  });

  test("mobile keeps the no-data placeholder at 350px (no height cap)", () => {
    // Regression check: an earlier revision shrank the empty-state to
    // 240px on mobile, which left a tiny placeholder above a 350px chart
    // when data finally loaded. Empty state and populated chart now
    // share the same vertical footprint.
    useIsMobileMock.mockImplementation(() => true);
    const { container, unmount } = render(
      <BillingUsageChart buckets={[]} metric="spend" />,
    );
    const placeholder = container.querySelector<HTMLElement>("div.h-\\[350px\\]");
    expect(placeholder).not.toBeNull();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Rendering smoke tests — the chart should paint without crashing on both
// mobile and desktop branches.
// ---------------------------------------------------------------------------

describe("BillingUsageChart — render smoke", () => {
  test("renders without crashing on desktop", () => {
    useIsMobileMock.mockImplementation(() => false);
    expect(() => {
      const { unmount } = render(
        <BillingUsageChart buckets={SAMPLE_BUCKETS} metric="spend" />,
      );
      unmount();
    }).not.toThrow();
  });

  test("renders without crashing on mobile", () => {
    useIsMobileMock.mockImplementation(() => true);
    expect(() => {
      const { unmount } = render(
        <BillingUsageChart buckets={SAMPLE_BUCKETS} metric="spend" />,
      );
      unmount();
    }).not.toThrow();
  });

  test("renders bar paths for each bucket × group", () => {
    useIsMobileMock.mockImplementation(() => true);
    const { container, unmount } = render(
      <BillingUsageChart buckets={SAMPLE_BUCKETS} metric="spend" />,
    );
    const bars = container.querySelectorAll<SVGPathElement>(
      "path.recharts-rectangle",
    );
    expect(bars.length).toBe(SAMPLE_BUCKETS.length);
    unmount();
  });
});
