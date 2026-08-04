/**
 * Tests for ScheduleDetailPanel's plugin-sourced treatment: sourced schedules
 * hide the Delete affordance and show plugin attribution in its place;
 * user-created schedules keep the Delete button.
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
