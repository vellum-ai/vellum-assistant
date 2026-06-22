/**
 * A failed notification mutation (e.g. a 500 on acknowledge) must surface as
 * a toast and must not escalate to an unhandled promise rejection.
 *
 * Drives the real `NotificationsPage` (real `@tanstack/react-query`) so the
 * actual mutation wiring is exercised; only the platform gates, the generated
 * query/mutation layer, and `toast` are mocked. Mirrors the mocking style in
 * `domains/contacts/contacts-page.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { ApiError } from "@/utils/api-errors";
import type { NotificationList } from "@/generated/api/types.gen";
import * as rqGen from "@/generated/api/@tanstack/react-query.gen";

// ---------------------------------------------------------------------------
// Module-level holders
// ---------------------------------------------------------------------------

let toastErrorCalls: string[] = [];
let ackShouldReject = false;
const unhandledRejections: unknown[] = [];

const NOTIFICATION = {
  id: "notif-1",
  notification_type: "info",
  is_read: false,
  is_resolved: false,
  title: "Test notification",
  body: "",
  last_seen_at: new Date().toISOString(),
  occurrence_count: 1,
} as unknown as NotificationList;

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

// Resolve the list query to one unread notification and make acknowledge
// reject. Other mutation hooks (snooze/pause) keep their real definitions —
// they aren't triggered here.
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  ...rqGen,
  organizationsNotificationsListOptions: () => ({
    queryKey: ["notificationsList", "test"],
    queryFn: async () => ({ results: [NOTIFICATION] }),
  }),
  organizationsNotificationsAcknowledgeCreateMutation: () => ({
    mutationKey: ["acknowledge", "test"],
    mutationFn: async () => {
      if (ackShouldReject) {
        throw new ApiError(500, "Server error");
      }
      return {};
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

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function onUnhandled(reason: unknown) {
  unhandledRejections.push(reason);
}

beforeEach(() => {
  toastErrorCalls = [];
  ackShouldReject = false;
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
    ackShouldReject = true;

    render(
      <Wrapper>
        <NotificationsPage />
      </Wrapper>,
    );

    // Wait for the list query to resolve and the card's action to render.
    const markRead = await waitFor(() => getButton("Mark as read"));
    fireEvent.click(markRead);

    // The 500 surfaces to the user as a toast carrying the server message...
    await waitFor(() => {
      expect(toastErrorCalls).toEqual(["Server error"]);
    });

    // ...and the rejection never escaped to window.onunhandledrejection.
    // `.mutate()` keeps it internal to React Query.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });
});
