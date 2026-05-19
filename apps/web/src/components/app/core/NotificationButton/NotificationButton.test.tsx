/**
 * Tests for the `NotificationButton` component.
 *
 * The web workspace does not run DOM-based tests, so we render via
 * `react-dom/server` and inspect the emitted HTML. `NotificationButton` pulls
 * in `useAuth` (context) and `useQuery` (React Query) — both are mocked at
 * the module level so the component can render deterministically and expose
 * the unread-count badge for typography assertions.
 */

import { describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module mocks — must be registered before the subject module is imported.
// ---------------------------------------------------------------------------

// Stub the auth context so `useAuth()` returns a minimal shape without
// requiring an <AuthProvider> wrapper.
mock.module("@/lib/auth.js", () => ({
  useAuth: () => ({ isLoggedIn: true }),
}));

// React Query's `useQuery` is mocked to return a summary with a non-zero
// unread count — this is what makes the badge span render, which is the
// element we need to assert typography on.
mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: () => ({ data: { unread_count: 3 } }),
}));

// The query-options factory is pulled in by the component, but since
// `useQuery` is fully mocked its return value is never read. Stub it out to
// avoid importing the heyapi schema module transitively.
mock.module(
  "@/clients/platform/@tanstack/react-query.gen",
  () => ({
    organizationsNotificationsSummaryRetrieveOptions: () => ({}),
  }),
);

// The NotificationPopover is only rendered inside the Popover.Content slot
// (closed by default), so it never appears in the static markup — but we
// still stub it to keep the import graph light.
mock.module("./_NotificationPopover.js", () => ({
  NotificationPopover: () => null,
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { NotificationButton } from "@/components/app/core/NotificationButton/NotificationButton.js";

describe("NotificationButton badge typography", () => {
  test("badge span uses text-label-small-default", () => {
    const html = renderToStaticMarkup(<NotificationButton />);
    // The badge is gated on unread_count > 0 — our mock returns 3.
    expect(html).toContain("text-label-small-default");
    // The legacy 10/600 fragment must be gone.
    expect(html).not.toContain("text-[10px]");
    expect(html).not.toContain("font-semibold");
  });

  test("badge renders the unread count", () => {
    const html = renderToStaticMarkup(<NotificationButton />);
    expect(html).toContain(">3<");
  });
});
