import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";

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
  fetchScheduleUsageSummary: fetchScheduleUsageSummaryMock,
}));

const {
  scheduleUsageSummaryQueryOptions,
  canOpenScheduleRunConversation,
  canOpenScheduleSourceConversation,
  formatScheduleCost,
  formatTimestamp,
  groupSchedules,
  pastOneTimeStatus,
  SYSTEM_TASK_URL_IDS,
  systemTaskKindFromUrlId,
} = await import("@/domains/settings/utils/schedule-formatters");
const { RecentRunsCard } = await import(
  "@/domains/settings/components/recent-runs-card"
);
const { CreateScheduleModal } = await import(
  "@/domains/settings/components/create-schedule-modal"
);
const { SystemTaskRow, SystemTasksSection } = await import(
  "@/domains/settings/components/system-tasks-section"
);

afterEach(() => {
  cleanup();
  navigateCalls.length = 0;
  createScheduleMock.mockClear();
  fetchScheduleUsageSummaryMock.mockClear();
  nowSpy?.mockRestore();
  nowSpy = null;
});

function schedule(overrides: Partial<Schedule> = {}): Schedule {
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

describe("groupSchedules", () => {
  const now = 1_761_792_000_000;

  test("splits one-shots into upcoming and past", () => {
    const recurring = schedule({ id: "r1", isOneShot: false });
    const upcoming = schedule({
      id: "u1",
      isOneShot: true,
      status: "active",
      enabled: true,
      lastRunAt: null,
      nextRunAt: now + 60_000,
    });
    const expired = schedule({
      id: "p1",
      isOneShot: true,
      status: "active",
      enabled: false,
      lastRunAt: null,
      nextRunAt: now - 60_000,
    });
    const completed = schedule({
      id: "p2",
      isOneShot: true,
      status: "fired",
      enabled: true,
      lastRunAt: now - 120_000,
      nextRunAt: now - 120_000,
    });

    const grouped = groupSchedules(
      [completed, recurring, upcoming, expired],
      now,
    );

    expect(grouped.recurring.map((s) => s.id)).toEqual(["r1"]);
    expect(grouped.upcomingOneTime.map((s) => s.id)).toEqual(["u1"]);
    expect(grouped.pastOneTime.map((s) => s.id)).toEqual(["p1", "p2"]);
  });

  test("a failed one-shot awaiting retry stays upcoming", () => {
    const retrying = schedule({
      id: "retry-1",
      isOneShot: true,
      status: "active",
      enabled: true,
      lastRunAt: now - 60_000,
      lastStatus: "error",
      nextRunAt: now + 60_000,
    });

    const grouped = groupSchedules([retrying], now);

    expect(grouped.upcomingOneTime.map((s) => s.id)).toEqual(["retry-1"]);
    expect(grouped.pastOneTime).toEqual([]);
  });

  test("in-flight and overdue-but-enabled one-shots stay out of the past bucket", () => {
    const firing = schedule({
      id: "firing-1",
      isOneShot: true,
      status: "firing",
      enabled: true,
      lastRunAt: now - 1_000,
      nextRunAt: now - 1_000,
    });
    const overdue = schedule({
      id: "overdue-1",
      isOneShot: true,
      status: "active",
      enabled: true,
      lastRunAt: null,
      nextRunAt: now - 60_000,
    });

    const grouped = groupSchedules([firing, overdue], now);

    expect(grouped.pastOneTime).toEqual([]);
    expect(grouped.upcomingOneTime.map((s) => s.id)).toEqual([
      "overdue-1",
      "firing-1",
    ]);
  });

  test("orders upcoming one-shots soonest first", () => {
    const later = schedule({
      id: "later",
      isOneShot: true,
      lastRunAt: null,
      nextRunAt: now + 120_000,
    });
    const sooner = schedule({
      id: "sooner",
      isOneShot: true,
      lastRunAt: null,
      nextRunAt: now + 60_000,
    });

    const grouped = groupSchedules([later, sooner], now);

    expect(grouped.upcomingOneTime.map((s) => s.id)).toEqual([
      "sooner",
      "later",
    ]);
  });
});

describe("pastOneTimeStatus", () => {
  test("labels completed, failed, and expired one-shots", () => {
    expect(
      pastOneTimeStatus(
        schedule({ lastRunAt: 1_761_792_000_000, lastStatus: "ok" }),
      ),
    ).toEqual({ label: "Completed", tone: "positive" });
    expect(
      pastOneTimeStatus(
        schedule({ lastRunAt: 1_761_792_000_000, lastStatus: "error" }),
      ),
    ).toEqual({ label: "Failed", tone: "negative" });
    expect(
      pastOneTimeStatus(schedule({ lastRunAt: null, nextRunAt: 1 })),
    ).toEqual({ label: "Expired", tone: "neutral" });
    expect(
      pastOneTimeStatus(
        schedule({ status: "cancelled", lastRunAt: 1_761_792_000_000 }),
      ),
    ).toEqual({ label: "Cancelled", tone: "neutral" });
    // failOneShotPermanently: retry cap exhausted → cancelled + error.
    expect(
      pastOneTimeStatus(
        schedule({
          status: "cancelled",
          lastStatus: "error",
          lastRunAt: 1_761_792_000_000,
        }),
      ),
    ).toEqual({ label: "Failed", tone: "negative" });
  });
});

describe("scheduleUsageSummaryQueryOptions", () => {
  test("resolves the usage window when the query fetches", async () => {
    const firstNow = Date.UTC(2026, 5, 2, 18, 30, 0);
    const secondNow = firstNow + 60_000;
    nowSpy = spyOn(Date, "now").mockReturnValue(firstNow);
    const options = scheduleUsageSummaryQueryOptions("assistant-1", "UTC");

    expect(options.queryKey).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: "schedulesUsagesummaryGet",
          path: { assistant_id: "assistant-1" },
        }),
      ]),
    );

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
      }),
    );

    expect(screen.queryByRole("button", { name: /Run now/i })).toBeNull();
    expect(screen.queryByText("system")).toBeNull();
    expect(screen.getByLabelText("enabled")).toBeTruthy();
    // Column labels live in the shared list header now, not in each row.
    expect(screen.queryByText("Cost (7d)")).toBeNull();
    expect(screen.getByText("$0.42")).toBeTruthy();
    expect(screen.queryByText("Runs (7d)")).toBeNull();
    expect(screen.getByText("2 runs")).toBeTruthy();
  });
});

describe("SystemTasksSection", () => {
  test("heartbeat list row shows a status dot; the toggle lives on the detail page", () => {
    render(
      createElement(SystemTasksSection, {
        heartbeatConfig: {
          enabled: true,
          intervalMs: 60 * 60_000,
          activeHoursStart: null,
          activeHoursEnd: null,
          cronExpression: null,
          timezone: null,
          nextRunAt: null,
          lastRunAt: null,
          success: true,
        },
        consolidationConfig: undefined,
        retrospectiveConfig: undefined,
        heartbeatUsage: readySystemTaskUsage,
        consolidationUsage: readySystemTaskUsage,
        retrospectiveUsage: readySystemTaskUsage,
        isLoading: false,
        hasError: false,
        onRetry: () => {},
        onSelectHeartbeat: () => {},
        onSelectConsolidation: () => {},
        onSelectRetrospective: () => {},
      }),
    );

    // System jobs are collapsed by default — expand the disclosure first.
    fireEvent.click(screen.getByRole("button", { name: /System/i }));

    expect(screen.queryByLabelText("Toggle Heartbeat")).toBeNull();
    expect(screen.getByLabelText("enabled")).toBeTruthy();
  });

  test("consolidation never renders an automatic-run toggle", () => {
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
        retrospectiveConfig: undefined,
        heartbeatUsage: readySystemTaskUsage,
        consolidationUsage: readySystemTaskUsage,
        retrospectiveUsage: readySystemTaskUsage,
        isLoading: false,
        hasError: false,
        onRetry: () => {},
        onSelectHeartbeat: () => {},
        onSelectConsolidation: () => {},
        onSelectRetrospective: () => {},
      }),
    );

    // System jobs are collapsed by default — expand the disclosure first.
    fireEvent.click(screen.getByRole("button", { name: /System/i }));

    expect(screen.queryByLabelText("Toggle Consolidation")).toBeNull();
    expect(screen.queryByRole("button", { name: /run now/i })).toBeNull();
    // Enabled consolidation reads like any other healthy system row: a status
    // dot, no management tag or helper copy (the detail page explains it).
    expect(screen.getByLabelText("enabled")).toBeTruthy();
    expect(screen.queryByText("Managed by Memory")).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Consolidation is part of Memory.",
    );
    // Heartbeat is hidden here, so its cached usage must not inflate the
    // aggregate cost on the collapsed trigger ($0.42, not $0.84).
    expect(document.body.textContent).toContain("$0.42 (7d)");
  });

  test("maps system task url ids to kinds, including memory retrospective", () => {
    expect(systemTaskKindFromUrlId(SYSTEM_TASK_URL_IDS.heartbeat)).toBe(
      "heartbeat",
    );
    expect(systemTaskKindFromUrlId(SYSTEM_TASK_URL_IDS.consolidation)).toBe(
      "consolidation",
    );
    expect(systemTaskKindFromUrlId(SYSTEM_TASK_URL_IDS.retrospective)).toBe(
      "retrospective",
    );
    expect(SYSTEM_TASK_URL_IDS.retrospective).toBe(
      "system-memory-retrospective",
    );
    expect(systemTaskKindFromUrlId("some-user-schedule")).toBeNull();
    expect(systemTaskKindFromUrlId(undefined)).toBeNull();
  });

  test("memory retrospective renders as a third system row with event-driven cadence and no Next timestamp", () => {
    let retrospectiveClicks = 0;

    render(
      createElement(SystemTasksSection, {
        heartbeatConfig: undefined,
        consolidationConfig: undefined,
        retrospectiveConfig: {
          available: true,
          enabled: true,
          intervalMs: 30 * 60_000,
          nextRunAt: null,
          lastRunAt: 1_761_792_000_000,
          success: true,
        },
        heartbeatUsage: readySystemTaskUsage,
        consolidationUsage: readySystemTaskUsage,
        retrospectiveUsage: readySystemTaskUsage,
        isLoading: false,
        hasError: false,
        onRetry: () => {},
        onSelectHeartbeat: () => {},
        onSelectConsolidation: () => {},
        onSelectRetrospective: () => {
          retrospectiveClicks += 1;
        },
      }),
    );

    // System jobs are collapsed by default — expand the disclosure first.
    fireEvent.click(screen.getByRole("button", { name: /System/i }));

    expect(screen.getByText("Memory retrospective")).toBeTruthy();
    expect(screen.getByText("After conversation activity")).toBeTruthy();
    // Event-driven: nextRunAt is always null and must render nothing —
    // no "Next: —" placeholder.
    expect(document.body.textContent).not.toContain("Next:");
    expect(document.body.textContent).toContain(
      `Last: ${formatTimestamp(1_761_792_000_000)}`,
    );
    expect(screen.queryByRole("button", { name: /run now/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Memory retrospective" }),
    );

    expect(retrospectiveClicks).toBe(1);
  });
});
