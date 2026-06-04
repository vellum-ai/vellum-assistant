import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import { routes } from "@/utils/routes";

import type {
  Schedule,
  ScheduleRun,
} from "@/domains/settings/types/schedules";

const navigateCalls: string[] = [];
const navigateMock = (to: string) => {
  navigateCalls.push(to);
};

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

const {
  canOpenScheduleRunConversation,
  canOpenScheduleSourceConversation,
  formatScheduleCost,
  RecentRunsCard,
} = await import("./schedules-page");

afterEach(() => {
  cleanup();
  navigateCalls.length = 0;
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
