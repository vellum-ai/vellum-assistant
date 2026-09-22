import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import {
  assistantsDomainsListOptions,
  assistantsEmailAddressesListOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  AssistantDomain,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { LS_ASSISTANT_INBOX_HIDDEN } from "@/utils/local-settings-keys";

const ASSISTANT_ID = "assistant-123";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

// The design library's index re-exports every name from this module, so the
// stand-in has to carry them all or the import graph fails to link.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { EmailManagedContent } = await import("./email-managed-content");

const NOT_ENTITLED = {
  plan_id: "base",
  status: "active",
  entitlements: { managed_email: false, phone_number: false },
} as unknown as SubscriptionResponse;

function renderNotEntitled() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveOptions().queryKey,
    NOT_ENTITLED,
  );
  for (const supportsManifest of [true, false]) {
    client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
      components: null,
      traits: null,
      customImageUrl: null,
    });
  }
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmailManagedContent
          assistantId="platform-assistant"
          assistantHandle="ada"
          emailRootDomain="example.com"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ENTITLED = {
  plan_id: "pro",
  status: "active",
  entitlements: { managed_email: true, phone_number: false },
} as unknown as SubscriptionResponse;

const PLATFORM_ASSISTANT_ID = "platform-assistant";

const DOMAIN: AssistantDomain = {
  id: "domain-1",
  subdomain: "ada",
  created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z",
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

/** Entitled, with the domain and address lists answered from the cache. */
function renderEntitled({ domain }: { domain: AssistantDomain | null }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveOptions().queryKey,
    ENTITLED,
  );
  const path = { path: { assistant_id: PLATFORM_ASSISTANT_ID } };
  client.setQueryData(assistantsDomainsListOptions(path).queryKey, {
    count: domain ? 1 : 0,
    next: null,
    previous: null,
    results: domain ? [domain] : [],
  });
  client.setQueryData(assistantsEmailAddressesListOptions(path).queryKey, {
    count: 0,
    next: null,
    previous: null,
    results: [],
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/channels/email"]}>
        <EmailManagedContent
          assistantId={PLATFORM_ASSISTANT_ID}
          assistantHandle="ada"
          emailRootDomain="example.com"
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.removeItem(LS_ASSISTANT_INBOX_HIDDEN);
});

afterEach(() => {
  cleanup();
  useClientFeatureFlagStore.setState({ assistantInbox: false });
  localStorage.removeItem(LS_ASSISTANT_INBOX_HIDDEN);
});

describe("EmailManagedContent · not entitled", () => {
  test("keeps the upgrade notice while the inbox flag is off", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: false });
    renderNotEntitled();

    expect(
      screen.getByText("Give your assistant its own email address"),
    ).toBeTruthy();
    expect(screen.queryByText("hi@ada.example.com")).toBeNull();
  });

  test("draws the inbox's pitch once the flag is on, without a title of its own", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: true });
    renderNotEntitled();

    expect(screen.getByText("hi@ada.example.com")).toBeTruthy();
    expect(
      screen.getByText("Your assistant reads, sorts, and replies for you"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Upgrade to Super/ }),
    ).toBeTruthy();
    // The Email section's header introduces the pitch; the body repeats none of it.
    expect(screen.queryByRole("heading")).toBeNull();
    expect(
      screen.queryByText("Give your assistant its own email address"),
    ).toBeNull();
    // Handles live on the platform; with no platform session there is no
    // handle modal to open, so the pitch offers none.
    expect(screen.queryByRole("button", { name: "Change handle" })).toBeNull();
    // Nothing to restore: the entry was never hidden.
    expect(screen.queryByRole("button", { name: "Add it back" })).toBeNull();
  });

  test("offers the way back when the rail entry was hidden, and takes it", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: true });
    localStorage.setItem(LS_ASSISTANT_INBOX_HIDDEN, "1");
    renderNotEntitled();

    fireEvent.click(screen.getByRole("button", { name: "Add it back" }));

    expect(localStorage.getItem(LS_ASSISTANT_INBOX_HIDDEN)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add it back" })).toBeNull();
  });
});

describe("EmailManagedContent · entitled, no address", () => {
  test("keeps the subdomain form while the inbox flag is off", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: false });
    renderEntitled({ domain: null });

    expect(screen.getByRole("button", { name: "Register" })).toBeTruthy();
    expect(screen.queryByTestId("email-inbox-setup-button")).toBeNull();
  });

  test("points to the inbox instead of registering a domain once the flag is on", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: true });
    renderEntitled({ domain: null });

    expect(
      screen.getByText("Set up email in the Assistant Inbox"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Register" })).toBeNull();

    fireEvent.click(screen.getByTestId("email-inbox-setup-button"));

    expect(screen.getByTestId("loc").textContent).toBe("/assistant/inbox");
  });

  test("with a domain but no address, keeps the domain row and points to the inbox for the address", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: true });
    renderEntitled({ domain: DOMAIN });

    // The domain row, with its release action, is still this page's.
    expect(screen.getByText("ada.example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release domain" })).toBeTruthy();
    // The address field is not: the inbox's card creates the address.
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.getByTestId("email-inbox-setup-button")).toBeTruthy();
  });
});
