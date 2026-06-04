import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";

import { routes } from "@/utils/routes";

import type { AssistantSchedule } from "@/utils/schedules";
import type { Conversation } from "@/types/conversation-types";

const fetchSchedulesMock = mock(
  async (_assistantId: string): Promise<AssistantSchedule[]> => [],
);

mock.module("@/utils/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
  getOpenableScheduleSourceConversationId: (schedule: AssistantSchedule) =>
    schedule.createdFromConversationId &&
    schedule.createdFromConversationExists === true &&
    schedule.createdFromConversationArchivedAt == null
      ? schedule.createdFromConversationId
      : null,
}));

const { ScheduledConversationOriginBanner } = await import(
  "@/domains/chat/components/scheduled-conversation-origin-banner"
);

afterEach(() => {
  cleanup();
  fetchSchedulesMock.mockClear();
});

function renderWithProviders(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, null, element),
    ),
  );
}

function scheduledConversation(
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    conversationId: "conv-run",
    conversationType: "scheduled",
    scheduleJobId: "schedule-1",
    ...overrides,
  };
}

function schedule(overrides: Partial<AssistantSchedule> = {}): AssistantSchedule {
  return {
    id: "schedule-1",
    name: "Water reminder 6/10",
    message: "💧 Sip #6.",
    createdFromConversationId: "conv-source",
    createdFromConversationExists: true,
    createdFromConversationArchivedAt: null,
    ...overrides,
  } as AssistantSchedule;
}

describe("ScheduledConversationOriginBanner", () => {
  test("shows the schedule prompt and original conversation link", async () => {
    fetchSchedulesMock.mockResolvedValueOnce([schedule()]);

    renderWithProviders(
      <ScheduledConversationOriginBanner
        assistantId="assistant-1"
        conversation={scheduledConversation()}
      />,
    );

    expect(fetchSchedulesMock).toHaveBeenCalledWith("assistant-1");
    expect(await screen.findByText("Started by schedule")).toBeTruthy();
    expect(screen.getByText("Water reminder 6/10")).toBeTruthy();
    expect(screen.getByText("Prompt:")).toBeTruthy();
    expect(screen.getByText("💧 Sip #6.")).toBeTruthy();

    const link = screen.getByRole("link", { name: "Original conversation" });
    expect(link.getAttribute("href")).toBe(routes.conversation("conv-source"));
    const scheduleLink = screen.getByRole("link", { name: "Schedule" });
    expect(scheduleLink.getAttribute("href")).toBe(
      routes.settings.schedule("schedule-1"),
    );
  });

  test("keeps scheduled conversations identifiable when schedule details are missing", async () => {
    fetchSchedulesMock.mockResolvedValueOnce([]);

    renderWithProviders(
      <ScheduledConversationOriginBanner
        assistantId="assistant-1"
        conversation={scheduledConversation()}
      />,
    );

    await waitFor(() => expect(fetchSchedulesMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Started by schedule")).toBeTruthy();
    expect(screen.getByText("Schedule details unavailable")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Original conversation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Schedule" })).toBeNull();
  });

  test("does not fetch or render for regular conversations", () => {
    renderWithProviders(
      <ScheduledConversationOriginBanner
        assistantId="assistant-1"
        conversation={scheduledConversation({
          conversationType: "standard",
          scheduleJobId: undefined,
        })}
      />,
    );

    expect(fetchSchedulesMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Started by schedule")).toBeNull();
  });
});
