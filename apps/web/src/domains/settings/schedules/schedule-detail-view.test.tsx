import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import userEvent from "@testing-library/user-event";

import { cleanup, render, screen } from "@/test-utils.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const deleteScheduleMock = mock(
  (..._args: unknown[]): Promise<void> => Promise.resolve(),
);
const fetchScheduleRunsMock = mock(
  (..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]),
);
const toastErrorMock = mock(() => {});

mock.module("@/lib/schedules/api.js", () => ({
  deleteSchedule: deleteScheduleMock,
  fetchScheduleRuns: fetchScheduleRunsMock,
  runScheduleNow: mock((..._args: unknown[]) => Promise.resolve()),
}));

mock.module("@tanstack/react-query", () => ({
  useQuery: mock(() => ({ data: [], isLoading: false, refetch: mock(() => {}) })),
}));

mock.module("@/components/app/core/Toast/Toast", () => ({
  toast: { error: toastErrorMock, success: mock(() => {}) },
}));

mock.module("@/lib/errors/report.js", () => ({
  reportError: mock(() => {}),
}));

import { ScheduleDetailView } from "@/domains/settings/schedules/page.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseSchedule = {
  id: "sched_1",
  name: "Morning briefing",
  description: "0 9 * * *",
  mode: "execute" as const,
  enabled: true,
  expression: "0 9 * * *",
  cronExpression: "0 9 * * *",
  syntax: "cron" as const,
  timezone: null,
  message: "Good morning",
  script: null,
  nextRunAt: 0,
  lastRunAt: null,
  lastStatus: null,
  status: "active" as const,
  routingIntent: "single_channel",
  reuseConversation: false,
  isOneShot: false,
};

const baseProps = {
  schedule: baseSchedule,
  assistantId: "asst_test",
  onBack: mock(() => {}),
  onDeleted: mock(() => {}),
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
  deleteScheduleMock.mockClear();
  fetchScheduleRunsMock.mockClear();
  toastErrorMock.mockClear();
  deleteScheduleMock.mockImplementation(
    (..._args: unknown[]): Promise<void> => Promise.resolve(),
  );
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScheduleDetailView — delete", () => {
  test("renders a Delete button in the danger zone", () => {
    render(<ScheduleDetailView {...baseProps} />);
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
  });

  test("clicking Delete shows confirmation buttons", async () => {
    render(<ScheduleDetailView {...baseProps} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(screen.getByRole("button", { name: /yes, delete/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
    // Initial Delete button should be gone
    expect(
      screen.queryByRole("button", { name: /^delete$/i }),
    ).toBeNull();
  });

  test("Cancel returns to initial state", async () => {
    render(<ScheduleDetailView {...baseProps} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  test("confirming delete calls deleteSchedule and fires onDeleted", async () => {
    const onDeleted = mock(() => {});
    render(<ScheduleDetailView {...baseProps} onDeleted={onDeleted} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(screen.getByRole("button", { name: /yes, delete/i }));

    expect(deleteScheduleMock).toHaveBeenCalledTimes(1);
    expect(deleteScheduleMock).toHaveBeenCalledWith("asst_test", "sched_1");
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  test("API error shows toast and resets confirmation state", async () => {
    deleteScheduleMock.mockImplementation(
      (..._args: unknown[]): Promise<void> =>
        Promise.reject(new Error("not found")),
    );
    const onDeleted = mock(() => {});
    render(<ScheduleDetailView {...baseProps} onDeleted={onDeleted} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(screen.getByRole("button", { name: /yes, delete/i }));

    expect(onDeleted).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    // Confirmation should be reset — Delete button is back
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
  });
});
