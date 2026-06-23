/**
 * Mutation error/cleanup behavior for the notifications page:
 *
 * 1. A failed mutation (e.g. a 500 on acknowledge) surfaces as a toast and
 *    must not escalate to an unhandled promise rejection.
 * 2. `ackMutation` is one observer shared by every row, so each in-flight ack
 *    must clean up its own `ackingIds` entry independently — overlapping acks
 *    must not leave a row stuck disabled.
 *
 * Drives the real `NotificationsPage` (real `@tanstack/react-query`); only the
 * platform gates, the generated query/mutation layer, and `toast` are mocked.
 * Mirrors `domains/contacts/contacts-page.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { ApiError } from "@/utils/api-errors";
import type { NotificationList } from "@/generated/api/types.gen";
import * as rqGen from "@/generated/api/@tanstack/react-query.gen";

// ---------------------------------------------------------------------------
// Module-level holders
// ---------------------------------------------------------------------------

let toastErrorCalls: string[] = [];
let notifications: NotificationList[] = [];
let ackMode: "reject" | "defer" = "reject";
const ackControllers: Array<{ resolve: () => void }> = [];
const unhandledRejections: unknown[] = [];

function makeNotification(id: string): NotificationList {
  return {
    id,
    notification_type: "info",
    is_read: false,
    is_resolved: false,
    title: `Test ${id}`,
    body: "",
    last_seen_at: new Date().toISOString(),
    occurrence_count: 1,
  } as unknown as NotificationList;
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

// Force the page past its platform-hosted gates so the live surface renders.
mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
}));

// The list resolves to the configured notifications. Acknowledge either
// rejects immediately ("reject") or stays pending until a test resolves it
// ("defer"), so concurrent acks can be interleaved deterministically. Other
// mutation hooks (snooze/pause) keep their real definitions — not triggered.
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  ...rqGen,
  organizationsNotificationsListOptions: () => ({
    queryKey: ["notificationsList", "test"],
    queryFn: async () => ({ results: notifications }),
  }),
  organizationsNotificationsAcknowledgeCreateMutation: () => ({
    mutationKey: ["acknowledge", "test"],
    mutationFn: () => {
      if (ackMode === "reject") {
        return Promise.reject(new ApiError(500, "Server error"));
      }
      return new Promise<unknown>((resolve) => {
        ackControllers.push({ resolve: () => resolve({}) });
      });
    },
  }),
}));

const { NotificationsPage } = await import(
  "@/domains/settings/pages/notifications-page"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function buttonsByText(label: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((b) => b.textContent?.trim() === label);
}

function onUnhandled(reason: unknown) {
  unhandledRejections.push(reason);
}

beforeEach(() => {
  toastErrorCalls = [];
  notifications = [makeNotification("notif-1")];
  ackMode = "reject";
  ackControllers.length = 0;
  unhandledRejections.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NotificationsPage mutation error handling", () => {
  test("a failed acknowledge surfaces a toast and does not reject", async () => {
    render(
      <Wrapper>
        <NotificationsPage />
      </Wrapper>,
    );

    const [markRead] = await waitFor(() => {
      const buttons = buttonsByText("Mark as read");
      if (buttons.length === 0) throw new Error("no card yet");
      return buttons;
    });
    fireEvent.click(markRead);

    // The 500 surfaces to the user as a toast carrying the server message...
    await waitFor(() => {
      expect(toastErrorCalls).toEqual(["Server error"]);
    });

    // ...and the rejection never escaped to window.onunhandledrejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });

  test("overlapping acks each clear their own loading state", async () => {
    // Two rows, both acked before either request settles. `ackMutation` is a
    // single shared observer, so per-`mutate` callbacks would only fire for
    // the latest call — leaving the first row stuck disabled. The per-ack
    // promise chain must clean up both.
    ackMode = "defer";
    notifications = [makeNotification("notif-1"), makeNotification("notif-2")];

    render(
      <Wrapper>
        <NotificationsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(buttonsByText("Mark as read").length).toBe(2);
    });

    const [first, second] = buttonsByText("Mark as read");
    fireEvent.click(first);
    fireEvent.click(second);

    // Both requests are in flight (both rows disabled).
    await waitFor(() => {
      expect(ackControllers.length).toBe(2);
    });
    expect(buttonsByText("Mark as read").every((b) => b.disabled)).toBe(true);

    // Settle both; every row must return to the enabled state.
    await act(async () => {
      ackControllers.forEach((c) => c.resolve());
    });

    await waitFor(() => {
      const buttons = buttonsByText("Mark as read");
      expect(buttons.length).toBe(2);
      expect(buttons.every((b) => !b.disabled)).toBe(true);
    });
    expect(unhandledRejections).toEqual([]);
  });
});
