import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { usageSeriesKeyForGroupValue } from "@/domains/settings/billing/usage/usage-series";
import type {
  UsageBreakdownResponse,
  UsageSeriesResponse,
  UsageTotals,
} from "@/domains/settings/billing/usage/usage-types";
import type { AssistantSchedule } from "@/utils/schedules";

const defaultSchedules = [
  { id: "schedule-123", name: "Morning digest" } as AssistantSchedule,
  { id: "schedule-456", name: "Evening digest" } as AssistantSchedule,
] as const;
let schedulesResponse: AssistantSchedule[] = [...defaultSchedules];
const fetchSchedulesMock = mock(
  async (): Promise<AssistantSchedule[]> => schedulesResponse,
);

// ---------------------------------------------------------------------------
// SDK mocks — each returns { data: T } matching throwOnError: true shape.
// The generated options factories call these internally; the breakdown query
// calls usageBreakdownGet directly.
// ---------------------------------------------------------------------------

function sdkScheduleId(opts: {
  query?: { scheduleId?: string };
}): string | undefined {
  return opts.query?.scheduleId;
}

const usageTotalsGetMock = mock(
  async (
    _opts: { query?: { scheduleId?: string } },
  ): Promise<{ data: UsageTotals }> => ({
    data: {
      totalInputTokens: 120,
      totalOutputTokens: 80,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalEstimatedCostUsd: 0.03,
      eventCount: 2,
      pricedEventCount: 2,
      unpricedEventCount: 0,
    },
  }),
);

const usageBreakdownGetMock = mock(
  async (opts: {
    query?: { scheduleId?: string };
  }): Promise<{ data: UsageBreakdownResponse }> => {
    const selectedScheduleId = sdkScheduleId(opts) ?? "schedule-123";
    const selectedSchedule = defaultSchedules.find(
      (schedule) => schedule.id === selectedScheduleId,
    );
    return {
      data: {
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
            turnCount: null,
          },
        ],
      },
    };
  },
);

const usageSeriesGetMock = mock(
  async (opts: {
    query?: { scheduleId?: string };
  }): Promise<{ data: UsageSeriesResponse }> => {
    const selectedScheduleId = sdkScheduleId(opts) ?? "schedule-123";
    const selectedSeriesKey = usageSeriesKeyForGroupValue(
      selectedScheduleId,
      "schedule",
    );
    const selectedSchedule = defaultSchedules.find(
      (schedule) => schedule.id === selectedScheduleId,
    );
    return {
      data: {
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
      },
    };
  },
);

const usageDailyGetMock = mock(
  async (_opts: Record<string, unknown>) => ({ data: { buckets: [] } }),
);

// ---------------------------------------------------------------------------
// Mock generated options factories — replaces @tanstack/react-query.gen
// so it never imports from sdk.gen (avoids ESM named-export validation issue)
// ---------------------------------------------------------------------------

function createQueryKeyMock(id: string, options: unknown) {
  const opts = options as Record<string, unknown> | undefined;
  return [{ _id: id, path: opts?.path, query: opts?.query }];
}

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  usageTotalsGetOptions: (opts: Record<string, unknown>) => ({
    queryKey: createQueryKeyMock("usageTotalsGet", opts),
    queryFn: async () => {
      const { data } = await usageTotalsGetMock(opts as never);
      return data;
    },
  }),
  usageDailyGetOptions: (opts: Record<string, unknown>) => ({
    queryKey: createQueryKeyMock("usageDailyGet", opts),
    queryFn: async () => {
      const { data } = await usageDailyGetMock(opts as never);
      return data;
    },
  }),
  usageSeriesGetOptions: (opts: Record<string, unknown>) => ({
    queryKey: createQueryKeyMock("usageSeriesGet", opts),
    queryFn: async () => {
      const { data } = await usageSeriesGetMock(opts as never);
      return data;
    },
  }),
  usageBreakdownGetQueryKey: (opts: Record<string, unknown>) =>
    createQueryKeyMock("usageBreakdownGet", opts),
  configLlmCallsitesGetOptions: (opts: Record<string, unknown>) => ({
    queryKey: createQueryKeyMock("configLlmCallsitesGet", opts),
    queryFn: async () => ({ domains: [], callSites: [] }),
  }),
  configGetOptions: (opts: Record<string, unknown>) => ({
    queryKey: createQueryKeyMock("configGet", opts),
    queryFn: async () => ({}),
  }),
  schedulesGetQueryKey: (opts: { path: { assistant_id: string } }) =>
    createQueryKeyMock("schedulesGet", opts),
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  usageBreakdownGet: usageBreakdownGetMock,
}));
mock.module("@/utils/conversation-navigation", () => ({
  navigateToNewConversation: mock(() => {}),
}));
mock.module("@/utils/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
}));
mock.module("@/utils/use-effective-timezone", () => ({
  useEffectiveTimezone: () => "UTC",
}));

const { UsageTab } = await import("./usage-tab");

afterEach(() => {
  cleanup();
  schedulesResponse = [...defaultSchedules];
  fetchSchedulesMock.mockClear();
  usageTotalsGetMock.mockClear();
  usageBreakdownGetMock.mockClear();
  usageSeriesGetMock.mockClear();
  usageDailyGetMock.mockClear();
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
        path: "/assistant/settings/billing",
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
      "/assistant/settings/billing?range=7d&groupBy=schedule&scheduleId=schedule-123",
    );

    await waitFor(() =>
      expect(usageSeriesGetMock.mock.calls).toHaveLength(1),
    );

    expect(
      screen.queryByLabelText("Schedule usage filter"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear schedule filter" }),
    ).toBeNull();
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(
      usageTotalsGetMock.mock.calls[0]?.[0]?.query?.scheduleId,
    ).toBe("schedule-123");
    expect(
      usageBreakdownGetMock.mock.calls[0]?.[0]?.query?.scheduleId,
    ).toBe("schedule-123");
    expect(
      usageSeriesGetMock.mock.calls[0]?.[0]?.query?.scheduleId,
    ).toBe("schedule-123");

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
      "/assistant/settings/billing?range=7d&groupBy=schedule&scheduleId=schedule-deleted",
    );

    await waitFor(() =>
      expect(usageSeriesGetMock.mock.calls).toHaveLength(1),
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

  test("reveals a Turns column when the Turns toggle is enabled", async () => {
    renderUsageTab("/assistant/settings/billing?range=7d&groupBy=schedule");

    await waitFor(() =>
      expect(usageBreakdownGetMock.mock.calls.length).toBeGreaterThan(0),
    );

    // Hidden by default.
    expect(
      screen.queryByRole("columnheader", { name: "Turns" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Turns" }));

    expect(
      screen.getByRole("columnheader", { name: "Turns" }),
    ).toBeTruthy();
    // The mocked breakdown row has turnCount: null (a non-conversation
    // grouping), so the cell renders an em dash rather than a number.
    expect(screen.getByText("—")).toBeTruthy();
  });
});
