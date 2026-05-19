import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import userEvent from "@testing-library/user-event";

import { cleanup, render, screen, within } from "@/test-utils.js";

import type { Schedule } from "@/lib/schedules/types.js";

const refetchMock = mock(() => Promise.resolve());
let schedulesData: Schedule[] = [];
let heartbeatConfigData:
  | {
      enabled: boolean;
      intervalMs: number;
      activeHoursStart: number | null;
      activeHoursEnd: number | null;
      cronExpression: string | null;
      timezone: string | null;
      nextRunAt: number | null;
      lastRunAt: number | null;
      success: boolean;
    }
  | undefined;
let heartbeatRunsData: Array<{
  id: string;
  jobId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  output: string | null;
  error: string | null;
  conversationId: string | null;
  createdAt: number;
}> = [];

mock.module("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: mock((options: { queryKey?: readonly unknown[] }) => {
    const queryKey = options.queryKey;
    if (queryKey?.[0] === "schedules") {
      return {
        data: schedulesData,
        isLoading: false,
        isError: false,
        refetch: refetchMock,
      };
    }
    if (queryKey?.[0] === "schedule-runs") {
      return {
        data: [],
        isLoading: false,
        isError: false,
        refetch: refetchMock,
      };
    }
    if (queryKey?.[0] === "system-task-runs") {
      return {
        data: heartbeatRunsData,
        isLoading: false,
        isError: false,
        refetch: refetchMock,
      };
    }
    if (queryKey?.[0] === "heartbeat-config") {
      return {
        data: heartbeatConfigData,
        isLoading: false,
        isError: false,
        refetch: refetchMock,
      };
    }
    if (queryKey?.[0] === "consolidation-config") {
      return {
        data: undefined,
        isLoading: false,
        isError: false,
        refetch: refetchMock,
      };
    }
    return {
      data: { results: [{ id: "asst_test" }] },
      isLoading: false,
      isError: false,
      refetch: refetchMock,
    };
  }),
}));

mock.module("@/lib/schedules/api.js", () => ({
  deleteSchedule: mock(() => Promise.resolve()),
  fetchConsolidationConfig: mock(() => Promise.resolve(undefined)),
  fetchHeartbeatConfig: mock(() => Promise.resolve(undefined)),
  fetchHeartbeatRuns: mock(() => Promise.resolve([])),
  fetchScheduleRuns: mock(() => Promise.resolve([])),
  fetchSchedules: mock(() => Promise.resolve([])),
  runConsolidationNow: mock(() =>
    Promise.resolve({ success: true, ran: true }),
  ),
  runHeartbeatNow: mock(() => Promise.resolve({ success: true, ran: true })),
  runScheduleNow: mock(() => Promise.resolve()),
  toggleSchedule: mock(() => Promise.resolve()),
}));

mock.module("@/components/app/core/Toast/Toast", () => ({
  toast: {
    error: mock(() => {}),
    info: mock(() => {}),
    success: mock(() => {}),
  },
}));

mock.module("@/lib/errors/report.js", () => ({
  reportError: mock(() => {}),
}));

mock.module(
  "@/domains/settings/schedules/create-schedule-modal.js",
  () => ({
    CreateScheduleModal: () => null,
  }),
);

import SchedulesSettingsPage from "@/domains/settings/schedules/page.js";

const baseSchedule: Schedule = {
  id: "sched_1",
  name: "Morning briefing",
  description: "0 9 * * *",
  mode: "execute",
  enabled: true,
  expression: "0 9 * * *",
  cronExpression: "0 9 * * *",
  syntax: "cron",
  timezone: null,
  message: "Good morning",
  script: null,
  nextRunAt: 1_800_000_000_000,
  lastRunAt: null,
  lastStatus: null,
  status: "active",
  routingIntent: "single_channel",
  reuseConversation: false,
  isOneShot: false,
};

beforeEach(() => {
  refetchMock.mockClear();
  schedulesData = [{ ...baseSchedule }];
  heartbeatConfigData = undefined;
  heartbeatRunsData = [];
});

afterEach(cleanup);

describe("SchedulesSettingsPage", () => {
  test("derives the selected schedule detail from refetched schedule data", async () => {
    const { rerender } = render(<SchedulesSettingsPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /morning briefing/i }));
    expect(screen.getByText("Enabled")).toBeTruthy();

    schedulesData = [{ ...baseSchedule, enabled: false }];
    rerender(<SchedulesSettingsPage />);

    expect(screen.getByText("Disabled")).toBeTruthy();
  });

  test("renders system events after user-defined schedules and before one-time schedules", () => {
    schedulesData = [
      { ...baseSchedule, id: "recurring", name: "Morning briefing" },
      {
        ...baseSchedule,
        id: "one_time",
        name: "Ship reminder",
        description: "Runs once",
        isOneShot: true,
        nextRunAt: 1_700_000_000_000,
      },
    ];
    heartbeatConfigData = {
      enabled: true,
      intervalMs: 60_000,
      activeHoursStart: null,
      activeHoursEnd: null,
      cronExpression: null,
      timezone: null,
      nextRunAt: 1_800_000_000_000,
      lastRunAt: null,
      success: true,
    };

    render(<SchedulesSettingsPage />);

    const headings = screen.getAllByRole("heading", { level: 2 });
    const labels = headings.map((heading) => heading.textContent);
    expect(labels.indexOf("Schedules")).toBeLessThan(labels.indexOf("System"));
    expect(labels.indexOf("System")).toBeLessThan(labels.indexOf("One-time"));
  });

  test("opens heartbeat runs from a system event row", async () => {
    heartbeatConfigData = {
      enabled: true,
      intervalMs: 60_000,
      activeHoursStart: null,
      activeHoursEnd: null,
      cronExpression: null,
      timezone: null,
      nextRunAt: 1_800_000_000_000,
      lastRunAt: 1_700_000_000_000,
      success: true,
    };
    heartbeatRunsData = [
      {
        id: "heartbeat_run_1",
        jobId: "heartbeat",
        status: "ok",
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_500,
        durationMs: 1_500,
        output: null,
        error: null,
        conversationId: "conv_1",
        createdAt: 1_700_000_000_000,
      },
    ];
    render(<SchedulesSettingsPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /heartbeat/i }));

    expect(screen.getByRole("heading", { name: "Heartbeat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recent runs" })).toBeTruthy();
    const recentRuns = screen
      .getByRole("heading", { name: "Recent runs" })
      .closest("section");
    expect(recentRuns).toBeTruthy();
    expect(
      within(recentRuns as HTMLElement).getByRole("button", {
        name: /run at/i,
      }),
    ).toBeTruthy();
  });
});
