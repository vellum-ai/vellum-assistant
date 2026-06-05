import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { usageSeriesKeyForGroupValue } from "@/domains/logs/usage-series";
import type {
  UsageBreakdownResponse,
  UsageSeriesResponse,
  UsageTotals,
} from "@/domains/logs/usage-types";
import type { AssistantSchedule } from "@/utils/schedules";

const defaultSchedules = [
  { id: "schedule-123", name: "Morning digest" } as AssistantSchedule,
  { id: "schedule-456", name: "Evening digest" } as AssistantSchedule,
] as const;
let schedulesResponse: AssistantSchedule[] = [...defaultSchedules];
const fetchSchedulesMock = mock(
  async (): Promise<AssistantSchedule[]> => schedulesResponse,
);
const fetchUsageTotalsMock = mock(
  async (
    _assistantId: string,
    _params: { scheduleId?: string },
  ): Promise<UsageTotals> => ({
    totalInputTokens: 120,
    totalOutputTokens: 80,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCostUsd: 0.03,
    eventCount: 2,
    pricedEventCount: 2,
    unpricedEventCount: 0,
  }),
);
const fetchUsageBreakdownMock = mock(
  async (
    _assistantId: string,
    params: { scheduleId?: string },
  ): Promise<UsageBreakdownResponse> => {
    const selectedScheduleId = params.scheduleId ?? "schedule-123";
    const selectedSchedule = defaultSchedules.find(
      (schedule) => schedule.id === selectedScheduleId,
    );
    return {
      breakdown: [
        {
          group: selectedSchedule?.name ?? "Deleted schedule",
          groupId: selectedScheduleId,
          groupKey: selectedScheduleId,
          totalInputTokens: 120,
          totalOutputTokens: 80,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalEstimatedCostUsd: 0.03,
          eventCount: 2,
        },
      ],
    };
  },
);
const fetchUsageSeriesMock = mock(
  async (
    _assistantId: string,
    params: { scheduleId?: string },
  ): Promise<UsageSeriesResponse> => {
    const selectedScheduleId = params.scheduleId ?? "schedule-123";
    const selectedSeriesKey = usageSeriesKeyForGroupValue(
      selectedScheduleId,
      "schedule",
    );
    const selectedSchedule = defaultSchedules.find(
      (schedule) => schedule.id === selectedScheduleId,
    );
    return {
      buckets: [
        {
          bucketId: "2026-06-01",
          date: "2026-06-01",
          displayLabel: "Jun 1",
          totalInputTokens: 120,
          totalOutputTokens: 80,
          totalEstimatedCostUsd: 0.03,
          eventCount: 2,
          groups: {
            [selectedSeriesKey]: {
              group: selectedSchedule?.name ?? "Deleted schedule",
              groupKey: selectedScheduleId,
              totalInputTokens: 120,
              totalOutputTokens: 80,
              totalEstimatedCostUsd: 0.03,
              eventCount: 2,
            },
          },
        },
      ],
    };
  },
);
const fetchUsageDailyMock = mock(async () => ({ buckets: [] }));
class UsageRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UsageRequestError";
    this.status = status;
  }
}

mock.module("@/utils/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
}));
mock.module("@/utils/use-effective-timezone", () => ({
  useEffectiveTimezone: () => "UTC",
}));
mock.module("@/domains/logs/usage-api", () => ({
  UsageRequestError,
  fetchUsageBreakdown: fetchUsageBreakdownMock,
  fetchUsageDaily: fetchUsageDailyMock,
  fetchUsageSeries: fetchUsageSeriesMock,
  fetchUsageTotals: fetchUsageTotalsMock,
}));

const { UsageTab } = await import("./usage-tab");

afterEach(() => {
  cleanup();
  schedulesResponse = [...defaultSchedules];
  fetchSchedulesMock.mockClear();
  fetchUsageTotalsMock.mockClear();
  fetchUsageBreakdownMock.mockClear();
  fetchUsageSeriesMock.mockClear();
  fetchUsageDailyMock.mockClear();
});

function renderUsageTab(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/assistant/logs/usage",
        element: createElement(UsageTab, { assistantId: "assistant-1" }),
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const element: ReactElement = createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(RouterProvider, { router }),
  );

  return render(element);
}

function readLegendItems(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[data-usage-legend-state]")).map(
    (item) => ({
      label: item.querySelectorAll("span")[1]!,
      state: item.getAttribute("data-usage-legend-state"),
    }),
  );
}

describe("UsageTab", () => {
  test("renders URL-selected schedule filters as an active legend instead of picker controls", async () => {
    const { container } = renderUsageTab(
      "/assistant/logs/usage?range=7d&groupBy=schedule&scheduleId=schedule-123",
    );

    await waitFor(() =>
      expect(fetchUsageSeriesMock.mock.calls).toHaveLength(1),
    );

    expect(
      screen.queryByLabelText("Schedule usage filter"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear schedule filter" }),
    ).toBeNull();
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(fetchUsageTotalsMock.mock.calls[0]?.[1]?.scheduleId).toBe(
      "schedule-123",
    );
    expect(fetchUsageBreakdownMock.mock.calls[0]?.[1]?.scheduleId).toBe(
      "schedule-123",
    );
    expect(fetchUsageSeriesMock.mock.calls[0]?.[1]?.scheduleId).toBe(
      "schedule-123",
    );

    const legendItems = readLegendItems(container);
    expect(legendItems.map((item) => item.label.textContent)).toEqual([
      "Morning digest",
      "Evening digest",
    ]);
    expect(legendItems.map((item) => item.state)).toEqual([
      "active",
      "inactive",
    ]);

    expect(legendItems[0]!.label.className).not.toContain("line-through");
    expect(legendItems[1]!.label.className).toContain("line-through");
  });

  test("renders an active fallback legend item for an unknown selected schedule", async () => {
    schedulesResponse = [
      { id: "schedule-456", name: "Evening digest" } as AssistantSchedule,
    ];
    const { container } = renderUsageTab(
      "/assistant/logs/usage?range=7d&groupBy=schedule&scheduleId=schedule-deleted",
    );

    await waitFor(() =>
      expect(fetchUsageSeriesMock.mock.calls).toHaveLength(1),
    );

    const legendItems = readLegendItems(container);
    expect(legendItems.map((item) => item.label.textContent)).toEqual([
      "Unknown schedule (schedule-deleted)",
      "Evening digest",
    ]);
    expect(legendItems.map((item) => item.state)).toEqual([
      "active",
      "inactive",
    ]);
  });
});
