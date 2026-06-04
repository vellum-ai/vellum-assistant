import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

const fetchScheduleUsageSummaryMock = mock(
  async (
    _assistantId: string,
    _range: ScheduleUsageSummaryRange,
  ): Promise<ScheduleUsageSummary[]> => [],
);
let nowSpy: ReturnType<typeof spyOn> | null = null;

mock.module("@/domains/settings/api/schedules", () => ({
  ...schedulesApi,
  fetchScheduleUsageSummary: fetchScheduleUsageSummaryMock,
}));

const {
  scheduleUsageSummaryQueryOptions,
  canOpenScheduleRunConversation,
  canOpenScheduleSourceConversation,
  formatScheduleCost,
  RecentRunsCard,
  ScheduleRow,
} = await import("./schedules-page");

afterEach(() => {
  cleanup();
  navigateCalls.length = 0;
  fetchScheduleUsageSummaryMock.mockClear();
  nowSpy?.mockRestore();
  nowSpy = null;
});

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
    expect(formatScheduleCost(0.0034)).toBe("$0.0034");
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
