import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import type { ReactElement } from "react";

import * as schedulesApi from "@/domains/settings/api/schedules";
import { routes } from "@/utils/routes";

import type {
  Schedule,
  ScheduleRun,
  ScheduleUsageSummary,
} from "@/domains/settings/types/schedules";
import type { ScheduleUsageSummaryRange } from "@/domains/settings/api/schedules";

const navigateCalls: string[] = [];
const navigateMock = (to: string) => {
  navigateCalls.push(to);
};

const reactRouter = await import("react-router");
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

const fetchScheduleUsageSummaryMock = mock(
  async (
    _assistantId: string,
    _range: ScheduleUsageSummaryRange,
  ): Promise<ScheduleUsageSummary[]> => [],
);
const fetchConsolidationRunsMock = mock(
  async (_assistantId: string): Promise<ScheduleRun[]> => [
    {
      id: "consolidation-run-1",
      jobId: "consolidation",
      status: "ok",
      startedAt: 1_761_792_000_000,
      finishedAt: 1_761_792_003_000,
      durationMs: 3000,
      output: null,
      error: null,
      conversationId: "conv-consolidation-1",
      conversationExists: true,
      conversationArchivedAt: null,
      estimatedCostUsd: 0.1234,
      createdAt: 1_761_792_000_000,
    },
  ],
);
const fetchScheduleRunsMock = mock(
  async (_assistantId: string, _scheduleId: string): Promise<ScheduleRun[]> => [],
);
const createScheduleMock = mock(
  async (
    _assistantId: string,
    _payload: schedulesApi.CreateSchedulePayload,
  ): Promise<void> => {},
);
let nowSpy: ReturnType<typeof spyOn> | null = null;

mock.module("@/domains/settings/api/schedules", () => ({
  ...schedulesApi,
  createSchedule: createScheduleMock,
  fetchConsolidationRuns: fetchConsolidationRunsMock,
  fetchScheduleRuns: fetchScheduleRunsMock,
  fetchScheduleUsageSummary: fetchScheduleUsageSummaryMock,
}));

const {
  scheduleUsageSummaryQueryOptions,
  canOpenScheduleRunConversation,
  canOpenScheduleSourceConversation,
  formatScheduleCost,
  formatTimestamp,
  shouldShowSystemTaskToggles,
} = await import("@/domains/settings/utils/schedule-formatters");
const { RecentRunsCard } = await import(
  "@/domains/settings/components/recent-runs-card"
);
const { CreateScheduleModal } = await import(
  "@/domains/settings/components/create-schedule-modal"
);
const { ScheduleDetailView } = await import(
  "@/domains/settings/components/schedule-detail-view"
);
const { ScheduleRow } = await import(
  "@/domains/settings/components/schedule-row"
);
const { SystemTaskRow, SystemTasksSection } = await import(
  "@/domains/settings/components/system-tasks-section"
);
const { SystemTaskDetailView } = await import(
  "@/domains/settings/components/system-task-detail-view"
);

afterEach(() => {
  cleanup();
  navigateCalls.length = 0;
  createScheduleMock.mockClear();
  fetchConsolidationRunsMock.mockClear();
  fetchScheduleRunsMock.mockClear();
  fetchScheduleUsageSummaryMock.mockClear();
  nowSpy?.mockRestore();
  nowSpy = null;
});

function renderWithQueryClient(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    createElement(QueryClientProvider, { client: queryClient }, element),
  );
}

function schedule(
  overrides: Partial<Schedule> = {},
): Schedule {
  return {
    createdFromConversationId: "conv-source",
    createdFromConversationExists: true,
    createdFromConversationArchivedAt: null,
    ...overrides,
  } as Schedule;
}

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    conversationId: "conv-run",
    conversationExists: true,
    conversationArchivedAt: null,
    ...overrides,
  } as ScheduleRun;
}

const readySystemTaskUsage = {
  status: "ready" as const,
  summary: {
    scheduleId: "system-heartbeat",
    runCount: 2,
    totalEstimatedCostUsd: 0.42,
    eventCount: 7,
  },
};

describe("canOpenScheduleSourceConversation", () => {
  test("requires an existing unarchived source conversation", () => {
    expect(canOpenScheduleSourceConversation(schedule())).toBe(true);
    expect(
      canOpenScheduleSourceConversation(
        schedule({ createdFromConversationId: null }),
      ),
    ).toBe(false);
    expect(
      canOpenScheduleSourceConversation(
        schedule({ createdFromConversationExists: false }),
      ),
    ).toBe(false);
    expect(
      canOpenScheduleSourceConversation(
        schedule({ createdFromConversationArchivedAt: 1_761_792_000_000 }),
      ),
    ).toBe(false);
  });
});

describe("canOpenScheduleRunConversation", () => {
  test("requires an existing unarchived run conversation", () => {
    expect(canOpenScheduleRunConversation(run())).toBe(true);
    expect(canOpenScheduleRunConversation(run({ conversationId: null }))).toBe(
      false,
    );
    expect(
      canOpenScheduleRunConversation(run({ conversationExists: false })),
    ).toBe(false);
    expect(
      canOpenScheduleRunConversation(
        run({ conversationArchivedAt: 1_761_792_000_000 }),
      ),
    ).toBe(false);
  });
});

describe("formatScheduleCost", () => {
  test("formats zero, cents, and tiny nonzero costs", () => {
    expect(formatScheduleCost(0)).toBe("$0.00");
    expect(formatScheduleCost(0.42)).toBe("$0.42");
    expect(formatScheduleCost(0.0034)).toBe("$0.00");
  });

  test("falls back when cost is missing or invalid", () => {
    expect(formatScheduleCost(null)).toBe("—");
    expect(formatScheduleCost(Number.NaN)).toBe("—");
  });
});

describe("scheduleUsageSummaryQueryOptions", () => {
  test("resolves the usage window when the query fetches", async () => {
    const firstNow = Date.UTC(2026, 5, 2, 18, 30, 0);
    const secondNow = firstNow + 60_000;
    nowSpy = spyOn(Date, "now").mockReturnValue(firstNow);
    const options = scheduleUsageSummaryQueryOptions("assistant-1", "UTC");

    expect(options.queryKey).toEqual([
      "schedule-usage-summary",
      "assistant-1",
      "UTC",
    ]);

    await options.queryFn();
    nowSpy.mockReturnValue(secondNow);
    await options.queryFn();

    expect(fetchScheduleUsageSummaryMock.mock.calls).toEqual([
      [
        "assistant-1",
        {
          from: Date.UTC(2026, 4, 27, 0, 0, 0),
          to: firstNow,
        },
      ],
      [
        "assistant-1",
        {
          from: Date.UTC(2026, 4, 27, 0, 0, 0),
          to: secondNow,
        },
      ],
    ]);
  });

  test("can be disabled when schedule row stats are not visible", () => {
    const options = scheduleUsageSummaryQueryOptions(
      "assistant-1",
      "UTC",
      false,
    );

    expect(options.enabled).toBe(false);
  });
});

describe("SystemTaskDetailView", () => {
  test("loads consolidation runs and renders conversation-backed cost rows", async () => {
    renderWithQueryClient(
      createElement(SystemTaskDetailView, {
        kind: "consolidation",
        assistantId: "assistant-1",
        name: "Memory consolidation",
        subtitle: "Summarizes old context",
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        isRunning: false,
        onBack: () => {},
        onRunNow: () => {},
      }),
    );

    await waitFor(() =>
      expect(fetchConsolidationRunsMock.mock.calls).toEqual([["assistant-1"]]),
    );

    await waitFor(() =>
      expect(document.body.textContent).toContain("$0.12"),
    );
    expect(screen.getByRole("button", { name: /Run now/i })).toBeTruthy();
    expect(document.body.textContent).toContain("On · Managed by Memory");
    expect(document.body.textContent).not.toContain(
      "Memory is off, so consolidation is paused.",
    );
    expect(document.body.textContent).not.toContain(
      "Run history is not available",
    );

    fireEvent.click(screen.getByRole("button", { name: /Run at/i }));

    expect(navigateCalls).toEqual([
      routes.conversation("conv-consolidation-1"),
    ]);
  });

  test("routes consolidation control through Memory settings", async () => {
    let memorySettingsClicks = 0;

    renderWithQueryClient(
      createElement(SystemTaskDetailView, {
        kind: "consolidation",
        assistantId: "assistant-1",
        name: "Memory consolidation",
        subtitle: "Summarizes old context",
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        isRunning: false,
        onBack: () => {},
        onRunNow: () => {},
        onOpenMemorySettings: () => {
          memorySettingsClicks += 1;
        },
      }),
    );

    await waitFor(() =>
      expect(fetchConsolidationRunsMock.mock.calls).toEqual([["assistant-1"]]),
    );

    expect(document.body.textContent).toContain(
      "Memory is off, so consolidation is paused.",
    );
    expect(
      (screen.getByRole("button", { name: /Run now/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: /Memory settings/i }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Turn on Memory/i }),
    );

    expect(memorySettingsClicks).toBe(1);
  });
});

describe("RecentRunsCard", () => {
  test("conversation-backed runs open the conversation", () => {
    render(
      createElement(RecentRunsCard, {
        runs: [
          run({
            id: "run-1",
            startedAt: 1_761_792_000_000,
            durationMs: 2500,
            estimatedCostUsd: 0.02,
            output: "stdout remains in the conversation",
          }),
        ],
        isLoading: false,
      }),
    );

    fireEvent.click(document.querySelector<HTMLElement>('[role="button"]')!);

    expect(navigateCalls).toEqual([routes.conversation("conv-run")]);
    expect(document.body.textContent).not.toContain(
      "stdout remains in the conversation",
    );
  });

  test("non-openable runs can show stored output and the full error locally", () => {
    const fullError =
      "Script failed after writing a long diagnostic payload. ".repeat(4) +
      "full-error-tail-marker";

    render(
      createElement(RecentRunsCard, {
        runs: [
          run({
            id: "run-2",
            conversationId: "conv-missing",
            conversationExists: false,
            startedAt: 1_761_792_000_000,
            durationMs: 100,
            estimatedCostUsd: 0.01,
            output: "stdout line\nsecond line",
            error: fullError,
          }),
        ],
        isLoading: false,
      }),
    );

    expect(document.body.textContent).not.toContain("stdout line");
    expect(document.body.textContent).not.toContain("full-error-tail-marker");

    fireEvent.click(document.querySelector<HTMLElement>('[role="button"]')!);

    expect(navigateCalls).toEqual([]);
    expect(document.body.textContent).toContain("stdout line");
    expect(document.body.textContent).toContain("second line");
    expect(document.body.textContent).toContain("full-error-tail-marker");
  });

  test("non-openable run fallback stays inline instead of restoring the old subpage", () => {
    render(
      createElement(RecentRunsCard, {
        runs: [
          run({
            id: "run-3",
            conversationId: null,
            startedAt: 1_761_792_000_000,
            output: "local output",
            error: "local error",
          }),
        ],
        isLoading: false,
      }),
    );

    fireEvent.click(document.querySelector<HTMLElement>('[role="button"]')!);

    expect(document.body.textContent).toContain("local output");
    expect(document.body.textContent).not.toContain("Run details");
    expect(document.body.textContent).not.toContain("Back to runs");
    expect(routes.settings.schedule("schedule-1")).not.toContain("/runs/");
  });
});

describe("ScheduleRow", () => {
  function rowSchedule(overrides: Partial<Schedule> = {}): Schedule {
    return schedule({
      id: "schedule-123",
      name: "Daily summary",
      description: "Summarize the day",
      cadenceDescription: "Every day at 9am",
      mode: "execute",
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      ...overrides,
    });
  }

  test("cost metric opens usage without opening row details", () => {
    let detailClicks = 0;
    let usageClicks = 0;

    render(
      createElement(ScheduleRow, {
        schedule: rowSchedule(),
        usage: {
          status: "ready",
          summary: {
            scheduleId: "schedule-123",
            runCount: 2,
            totalEstimatedCostUsd: 0.42,
            eventCount: 7,
          },
        },
        onClick: () => {
          detailClicks += 1;
        },
        onToggle: () => {},
        onOpenUsage: () => {
          usageClicks += 1;
        },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /view usage/i }));

    expect(usageClicks).toBe(1);
    expect(detailClicks).toBe(0);
    expect(navigateCalls).toEqual([]);
  });

  test("run count metric is not clickable", () => {
    let detailClicks = 0;
    let usageClicks = 0;

    render(
      createElement(ScheduleRow, {
        schedule: rowSchedule(),
        usage: {
          status: "ready",
          summary: {
            scheduleId: "schedule-123",
            runCount: 2,
            totalEstimatedCostUsd: 0.42,
            eventCount: 7,
          },
        },
        onClick: () => {
          detailClicks += 1;
        },
        onToggle: () => {},
        onOpenUsage: () => {
          usageClicks += 1;
        },
      }),
    );

    fireEvent.click(screen.getByText("2 runs"));

    expect(usageClicks).toBe(0);
    expect(detailClicks).toBe(0);
    expect(screen.queryByText("execute")).toBeNull();
  });

  test("renders the last run timestamp without a status dot", () => {
    const lastRunAt = 1_761_792_000_000;

    render(
      createElement(ScheduleRow, {
        schedule: rowSchedule({
          lastRunAt,
          lastStatus: "ok",
        }),
        usage: {
          status: "ready",
          summary: {
            scheduleId: "schedule-123",
            runCount: 1,
            totalEstimatedCostUsd: 0.03,
            eventCount: 1,
          },
        },
        onClick: () => {},
        onToggle: () => {},
        onOpenUsage: () => {},
      }),
    );

    expect(screen.getByText(formatTimestamp(lastRunAt))).toBeTruthy();
    expect(screen.queryByLabelText("ok")).toBeNull();
  });

  test("renders the next run timestamp before a schedule has run", () => {
    const nextRunAt = 1_761_795_600_000;

    render(
      createElement(ScheduleRow, {
        schedule: rowSchedule({
          nextRunAt,
          lastRunAt: null,
        }),
        usage: {
          status: "ready",
          summary: {
            scheduleId: "schedule-123",
            runCount: 0,
            totalEstimatedCostUsd: 0,
            eventCount: 0,
          },
        },
        onClick: () => {},
        onToggle: () => {},
        onOpenUsage: () => {},
      }),
    );

    expect(screen.getByText(formatTimestamp(nextRunAt))).toBeTruthy();
  });

  test("renders authored description and recurring cadence as separate row text", () => {
    render(
      createElement(ScheduleRow, {
        schedule: rowSchedule({
          description: "Summarize customer updates",
          cadenceDescription: "Every weekday at 9am",
        }),
        usage: {
          status: "ready",
          summary: {
            scheduleId: "schedule-123",
            runCount: 0,
            totalEstimatedCostUsd: 0,
            eventCount: 0,
          },
        },
        onClick: () => {},
        onToggle: () => {},
        onOpenUsage: () => {},
      }),
    );

    expect(screen.getByText("Summarize customer updates")).toBeTruthy();
    expect(screen.getByText("Every weekday at 9am")).toBeTruthy();
  });

  test("one-time rows show authored descriptions and omit the generated one-time label", () => {
    const { container } = render(
      createElement(ScheduleRow, {
        schedule: rowSchedule({
          description: "Send the launch reminder",
          cadenceDescription: "One-time",
          isOneShot: true,
        }),
        usage: {
          status: "ready",
          summary: {
            scheduleId: "schedule-123",
            runCount: 0,
            totalEstimatedCostUsd: 0,
            eventCount: 0,
          },
        },
        onClick: () => {},
        onToggle: () => {},
        onOpenUsage: () => {},
      }),
    );

    expect(screen.getByText("Send the launch reminder")).toBeTruthy();
    expect(screen.queryByText("One-time")).toBeNull();

    const row = container.firstElementChild;
    expect(row?.className).toContain("rounded-md");
    expect(row?.className).toContain("hover:bg-[var(--surface-hover)]");

    const detailButton = screen.getByText("Daily summary").closest("button");
    expect(detailButton?.className).toContain("cursor-pointer");
    expect(detailButton?.className).toContain(
      "focus-visible:ring-[var(--ring)]",
    );
  });

  test("renders loading placeholders and unavailable error stats", () => {
    const { rerender } = render(
      createElement(ScheduleRow, {
        schedule: rowSchedule(),
        usage: { status: "loading" },
        onClick: () => {},
        onToggle: () => {},
        onOpenUsage: () => {},
      }),
    );

    expect(screen.getByLabelText("Loading schedule usage")).toBeTruthy();

    rerender(
      createElement(ScheduleRow, {
        schedule: rowSchedule(),
        usage: { status: "error" },
        onClick: () => {},
        onToggle: () => {},
        onOpenUsage: () => {},
      }),
    );

    expect(screen.getAllByText("--")).toHaveLength(2);
  });
});

describe("CreateScheduleModal", () => {
  test("requires a description and sends the trimmed value in the create payload", async () => {
    render(
      createElement(CreateScheduleModal, {
        isOpen: true,
        assistantId: "assistant-1",
        onClose: () => {},
        onCreated: () => {},
      }),
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " Morning briefing " },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: " Report on overnight updates " },
    });

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Create schedule" })
        .disabled,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: " Start the day with the most important changes " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() =>
      expect(createScheduleMock.mock.calls).toEqual([
        [
          "assistant-1",
          expect.objectContaining({
            name: "Morning briefing",
            description: "Start the day with the most important changes",
            expression: "0 9 * * *",
            message: "Report on overnight updates",
            timezone: expect.any(String),
          }),
        ],
      ]),
    );
  });
});

describe("ScheduleDetailView", () => {
  test("uses authored description as the subtitle and shows cadence in metadata", async () => {
    renderWithQueryClient(
      createElement(ScheduleDetailView, {
        schedule: schedule({
          id: "schedule-123",
          name: "Launch reminder",
          description: "Send the launch reminder",
          cadenceDescription: "One-time",
          mode: "execute",
          enabled: true,
          nextRunAt: 1_761_792_000_000,
          lastRunAt: null,
          lastStatus: null,
        }),
        assistantId: "assistant-1",
        onBack: () => {},
        onDeleted: () => {},
        onUpdated: () => {},
      }),
    );

    expect(screen.getByText("Launch reminder")).toBeTruthy();
    expect(screen.getByText("Send the launch reminder")).toBeTruthy();
    expect(screen.getByText("Cadence")).toBeTruthy();
    expect(screen.getByText("One-time")).toBeTruthy();

    await waitFor(() =>
      expect(fetchScheduleRunsMock.mock.calls).toEqual([
        ["assistant-1", "schedule-123"],
      ]),
    );
  });
});

describe("SystemTaskRow", () => {
  test("opens details from the row-level control", () => {
    let detailClicks = 0;

    render(
      createElement(SystemTaskRow, {
        name: "Heartbeat",
        subtitle: "Every 5 min",
        enabled: true,
        nextRunAt: 1_761_792_000_000,
        lastRunAt: 1_761_792_003_000,
        usage: readySystemTaskUsage,
        onClick: () => {
          detailClicks += 1;
        },
        showToggle: false,
        onToggle: () => {},
      }),
    );

    const row = screen.getByRole("button", { name: "Open Heartbeat" });
    fireEvent.click(row);

    expect(detailClicks).toBe(1);
  });

  test("omits list-level run now while keeping status and usage content", () => {
    render(
      createElement(SystemTaskRow, {
        name: "Heartbeat",
        subtitle: "Every 5 min",
        enabled: true,
        nextRunAt: 1_761_792_000_000,
        lastRunAt: 1_761_792_003_000,
        usage: readySystemTaskUsage,
        onClick: () => {},
        showToggle: false,
        onToggle: () => {},
      }),
    );

    expect(screen.queryByRole("button", { name: /Run now/i })).toBeNull();
    expect(screen.queryByText("system")).toBeNull();
    expect(screen.getByLabelText("enabled")).toBeTruthy();
    expect(screen.getByText("Cost (7d)")).toBeTruthy();
    expect(screen.getByText("$0.42")).toBeTruthy();
    expect(screen.getByText("Runs (7d)")).toBeTruthy();
    expect(screen.getByText("2 runs")).toBeTruthy();
  });
});

describe("system task toggles", () => {
  test("only presents system task toggles after the feature flag has hydrated on", () => {
    expect(shouldShowSystemTaskToggles(false, true)).toBe(false);
    expect(shouldShowSystemTaskToggles(true, false)).toBe(false);
    expect(shouldShowSystemTaskToggles(true, true)).toBe(true);
  });

  test("hides the system task toggle when the presentation flag is off", () => {
    render(
      createElement(SystemTaskRow, {
        name: "Heartbeat",
        subtitle: "Every 1 hr",
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        usage: readySystemTaskUsage,
        showToggle: false,
        onClick: () => {},
        onToggle: () => {},
      }),
    );

    expect(screen.queryByLabelText("Toggle Heartbeat")).toBeNull();
    expect(screen.queryByRole("button", { name: /run now/i })).toBeNull();
  });

  test("consolidation never renders an automatic-run toggle", () => {
    const toggleCalls: boolean[] = [];

    render(
      createElement(SystemTasksSection, {
        heartbeatConfig: undefined,
        consolidationConfig: {
          available: true,
          enabled: true,
          intervalMs: 4 * 60 * 60_000,
          nextRunAt: null,
          lastRunAt: null,
          success: true,
        },
        heartbeatUsage: readySystemTaskUsage,
        consolidationUsage: readySystemTaskUsage,
        isLoading: false,
        hasError: false,
        onRetry: () => {},
        onSelectHeartbeat: () => {},
        onSelectConsolidation: () => {},
        showSystemTaskToggles: true,
        onToggleHeartbeat: (enabled: boolean) => {
          toggleCalls.push(enabled);
        },
      }),
    );

    expect(screen.queryByLabelText("Toggle Consolidation")).toBeNull();
    expect(toggleCalls).toEqual([]);
    expect(screen.queryByRole("button", { name: /run now/i })).toBeNull();
    // Enabled consolidation reads like any other healthy system row: a status
    // dot, no management tag or helper copy (the detail page explains it).
    expect(screen.getByLabelText("enabled")).toBeTruthy();
    expect(screen.queryByText("Managed by Memory")).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Consolidation is part of Memory.",
    );
  });
});
