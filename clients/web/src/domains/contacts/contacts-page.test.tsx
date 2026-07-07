/**
 * A failing contact mutation (e.g. a gateway 404) must surface as a toast
 * and must not escalate to an unhandled promise rejection.
 *
 * Drives the real `ContactsPage` (real `@tanstack/react-query`) so the
 * actual mutation wiring is exercised; only the gateway, the generated
 * query layer, and `toast` are mocked. Mirrors the mocking style in
 * `domains/settings/ai/provider-create-form.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { ApiError } from "@/utils/api-errors";
import type { ContactPayload } from "@/domains/contacts/types";
import * as rqGen from "@/generated/daemon/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module-level holders
// ---------------------------------------------------------------------------

let toastErrorCalls: string[] = [];
let upsertShouldReject = false;
const unhandledRejections: unknown[] = [];

const GUARDIAN = {
  id: "c-guardian",
  role: "guardian",
  displayName: "Example User",
  notes: "",
  channels: [],
  interactionCount: 0,
  contactType: null,
} as unknown as ContactPayload;

const CONTACTS_KEY = ["contactsGet", "test"] as const;

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

mock.module("@/domains/contacts/contacts-gateway", () => ({
  upsertContact: async () => {
    if (upsertShouldReject) {
      throw new ApiError(404, "Not found");
    }
    return GUARDIAN;
  },
  deleteContact: async () => {},
  verifyContactChannel: async () => {},
  redeemA2AInvite: async () => ({ success: true }),
}));

// Resolve every query the page renders synchronously to a fixture so the
// guardian auto-selects and no real network is attempted. Real mutation
// hooks (merge / channel-patch) are kept — they aren't fired here.
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...rqGen,
  contactsGetOptions: () => ({
    queryKey: CONTACTS_KEY,
    queryFn: async () => ({ contacts: [GUARDIAN] }),
  }),
  contactsGetQueryKey: () => CONTACTS_KEY,
  contactsGetSetQueryData: () => {},
  channelsReadinessGetOptions: () => ({
    queryKey: ["channelsReadiness", "test"],
    queryFn: async () => ({ snapshots: [] }),
  }),
  channelsReadinessGetQueryKey: () => ["channelsReadiness", "test"],
  channelsAvailableGetOptions: () => ({
    queryKey: ["channelsAvailable", "test"],
  }),
  integrationsSlackChannelConfigGetOptions: () => ({
    queryKey: ["slackConfig", "test"],
    queryFn: async () => ({ threadMode: "single" }),
  }),
  integrationsSlackChannelConfigGetQueryKey: () => ["slackConfig", "test"],
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  channelsAvailableGet: async () => ({
    data: undefined,
    error: undefined,
    response: { ok: false, status: 404 },
  }),
}));

const { ContactsPage } = await import("@/domains/contacts/contacts-page");

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
  return createElement(
    MemoryRouter,
    null,
    createElement(QueryClientProvider, { client }, children),
  );
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((el) => el.placeholder === placeholder);
  if (!input) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return input;
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
  upsertShouldReject = false;
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

describe("ContactsPage legacy setup deep link", () => {
  test("?setup= deep link redirects to the Channels tab with the param intact", async () => {
    // Old builds' mobile chat handoff (and saved links) pointed channel
    // setup at this page; the credential forms now live only on the
    // Channels tab, so the page must forward the link there.
    function ChannelsMarker() {
      const location = useLocation();
      return createElement(
        "div",
        { "data-testid": "channels-page" },
        location.search,
      );
    }

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/assistant/contacts?setup=slack"] },
        createElement(
          QueryClientProvider,
          {
            client: new QueryClient({
              defaultOptions: { queries: { retry: false } },
            }),
          },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/assistant/contacts",
              element: createElement(ContactsPage, { assistantId: "asst-1" }),
            }),
            createElement(Route, {
              path: "/assistant/channels",
              element: createElement(ChannelsMarker),
            }),
          ),
        ),
      ),
    );

    await waitFor(() => {
      const marker = document.querySelector('[data-testid="channels-page"]');
      expect(marker).not.toBeNull();
      expect(marker!.textContent).toBe("?setup=slack");
    });
  });
});

describe("ContactsPage mutation error handling", () => {
  test("a failed contact save surfaces a toast and does not reject", async () => {
    upsertShouldReject = true;

    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    // The guardian auto-selects, rendering its editable Name field.
    const nameInput = await waitFor(() => getInputByPlaceholder("Your name"));

    // Dirty the form so Save enables, then submit.
    fireEvent.change(nameInput, { target: { value: "Example Guardian" } });
    fireEvent.click(getButton("Save"));

    // The gateway 404 is surfaced to the user as a toast carrying the
    // server message...
    await waitFor(() => {
      expect(toastErrorCalls).toEqual(["Not found"]);
    });

    // ...and the rejection never escaped to window.onunhandledrejection.
    // `.mutate()` keeps it internal to React Query.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });
});
