/**
 * Tests for ScheduleDetailPanel's plugin-sourced treatment: sourced schedules
 * hide the Delete affordance and show plugin attribution in its place;
 * user-created schedules keep the Delete button. Run now is withheld from a
 * plugin-sourced schedule that is turned off, since the daemon refuses to run
 * one whose plugin is disabled.
 *
 * The generated daemon SDK is mocked so the runs query resolves without a
 * daemon.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

import { makeSchedule } from "./schedule-test-fixtures";

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  schedulesByIdRunsGet: async () => ({
    data: { runs: [], nextCursor: null },
    error: undefined,
    response: { ok: true, status: 200 },
  }),
}));

const { ScheduleDetailPanel } = await import("./schedule-detail-panel");

afterEach(cleanup);

function renderPanel(schedule: ReturnType<typeof makeSchedule>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ScheduleDetailPanel
          schedule={schedule}
          assistantId="assistant-1"
          usage={{ status: "error" }}
          onClose={() => {}}
          onDeleted={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScheduleDetailPanel plugin-sourced treatment", () => {
  test("user-created schedules keep the Delete button", async () => {
    const { getByText, queryByText } = renderPanel(makeSchedule());

    await waitFor(() => {
      expect(getByText("Delete")).toBeTruthy();
    });
    expect(queryByText(/Managed by plugin/)).toBeNull();
  });

  test("plugin-sourced schedules hide Delete and show plugin attribution", async () => {
    const { getByText, queryByText } = renderPanel(
      makeSchedule({ sourceKey: "plugin:gmail/poll-inbox" }),
    );

    await waitFor(() => {
      expect(getByText("Managed by plugin gmail")).toBeTruthy();
    });
    expect(queryByText("Delete")).toBeNull();
  });
});

describe("ScheduleDetailPanel Run now availability", () => {
  const scriptSchedule = (overrides: Parameters<typeof makeSchedule>[0]) =>
    makeSchedule({ mode: "script", script: "echo hi", ...overrides });

  test("a disabled plugin-sourced schedule cannot be run", async () => {
    const { getByRole, getByText } = renderPanel(
      scriptSchedule({
        sourceKey: "plugin:gmail/poll-inbox",
        enabled: false,
        userEnabled: false,
      }),
    );

    await waitFor(() => {
      expect(
        (getByRole("button", { name: "Run now" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
    expect(getByText("Turn this schedule on to run it")).toBeTruthy();
  });

  test("an enabled plugin-sourced schedule can be run", async () => {
    const { getByRole, queryByText } = renderPanel(
      scriptSchedule({ sourceKey: "plugin:gmail/poll-inbox", enabled: true }),
    );

    await waitFor(() => {
      expect(
        (getByRole("button", { name: "Run now" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(queryByText("Turn this schedule on to run it")).toBeNull();
  });

  test("a disabled user-created schedule can still be run", async () => {
    const { getByRole } = renderPanel(scriptSchedule({ enabled: false }));

    await waitFor(() => {
      expect(
        (getByRole("button", { name: "Run now" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });
});
