/**
 * Gate tests for `EmailChannelSection`'s managed-email subscription gate.
 *
 * The gate keys off the `managed_email` entitlement, NOT `plan_id`, so an
 * admin `EntitlementOverride` that grants managed email to a Base org is
 * honored in-product. We verify both directions:
 *
 *  - Base org WITHOUT the entitlement → "Upgrade" notice, form gated.
 *  - Base org WITH the entitlement (override) → domain/address form renders,
 *    proving the gate reads the entitlement and not the plan.
 *
 * Strategy mirrors `plugins-tab.test.tsx`: pre-populate the React Query cache
 * via the generated query-key helper so `renderToStaticMarkup` (single-pass,
 * never resolves a pending queryFn) renders the loaded state directly.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import {
  assistantsListQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

// The settings-card barrel re-exports toast surfaces; stub them so barrel
// resolution doesn't pull the real toast module during the static render.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

// These tests exercise the subscription entitlement gate, not the platform
// gate. Mock usePlatformGate to always return "full" so the managed email
// form renders and the entitlement logic is reachable.
mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
}));

let nativeAndroid = false;

const platformDetection = await import("@/runtime/platform-detection");
mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  detectElectronHostOS: () => null,
  isNativeAndroid: () => nativeAndroid,
  useIsNativeAndroid: () => nativeAndroid,
}));

const ASSISTANT_ID = "asst-1";

// Seed the selection store so useActiveAssistantId() (called by
// EmailChannelSection) finds a non-null id without a route-level gate.
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

// Platform-id resolution is effect-driven and never settles under
// renderToStaticMarkup; resolve it synchronously so the managed form
// (and the entitlement gate under test) renders.
mock.module("@/hooks/use-platform-assistant-id", () => ({
  usePlatformAssistantId: () => ({
    platformAssistantId: ASSISTANT_ID,
    isLoading: false,
    error: null,
  }),
}));

const { EmailChannelSection } =
  await import("@/domains/channels/components/email-channel-section");

const ASSISTANT_HANDLE = "my-assistant";

beforeEach(() => {
  nativeAndroid = false;
});

function makeSubscription(
  managedEmail: boolean,
  planId: SubscriptionResponse["plan_id"] = "base",
): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: managedEmail, phone_number: false },
  };
}

function renderCard(subscription: SubscriptionResponse): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(assistantsListQueryKey(), {
    results: [{ id: ASSISTANT_ID, handle: ASSISTANT_HANDLE }],
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmailChannelSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EmailChannelSection managed-email gate", () => {
  test("Base org without the managed_email entitlement sees the upgrade notice", () => {
    const html = renderCard(makeSubscription(false, "base"));
    expect(html).toContain("Upgrade");
    expect(html).toContain("Give your assistant its own email address");
    expect(html).toContain(
      "Upgrade to a plan that includes an email address for your assistant. No provider setup required.",
    );
    // The domain registration form must NOT render when gated.
    expect(html).not.toContain("Register");
  });

  test("Base org WITH the managed_email entitlement sees the form, not the notice", () => {
    // plan_id stays "base" — only the entitlement (admin override) is true.
    const html = renderCard(makeSubscription(true, "base"));
    expect(html).not.toContain("Give your assistant its own email address");
    // The domain registration form renders for entitled orgs.
    expect(html).toContain("Subdomain");
    expect(html).toContain("Register");
  });

  test("native Android keeps the upgrade action, same as iOS", () => {
    nativeAndroid = true;
    const html = renderCard(makeSubscription(false, "base"));

    expect(html).not.toContain("Manage your subscription on our website.");
    expect(html).toContain(">Upgrade<");
  });

  test("Successful payload WITHOUT entitlements is treated as unknown and fails open", () => {
    // Simulates an older platform deploy / partial response: a successful
    // subscription payload that omits `entitlements` entirely. This must be
    // treated as unknown (fail-open), NOT as explicit denial, so otherwise
    // eligible users (e.g. Pro) aren't locked out of their managed email.
    const subscriptionWithoutEntitlements = {
      plan_id: "pro",
      status: "active",
      renewal_date: null,
      current_period_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
    } as unknown as SubscriptionResponse;
    const html = renderCard(subscriptionWithoutEntitlements);
    expect(html).not.toContain("Give your assistant its own email address");
    // The domain registration form renders (fail-open).
    expect(html).toContain("Subdomain");
    expect(html).toContain("Register");
  });
});

describe("EmailChannelSection header with the Assistant Inbox flag", () => {
  afterEach(() => {
    cleanup();
    useClientFeatureFlagStore.setState({ assistantInbox: false });
  });

  // Client-rendered, unlike the gate tests above: under
  // `renderToStaticMarkup` a Zustand store serves its initial state, so a
  // flag set for the test would never be seen.
  function renderSection(subscription: SubscriptionResponse): void {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(assistantsListQueryKey(), {
      results: [{ id: ASSISTANT_ID, handle: ASSISTANT_HANDLE }],
    });
    client.setQueryData(
      organizationsBillingSubscriptionRetrieveQueryKey(),
      subscription,
    );
    for (const supportsManifest of [true, false]) {
      client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
        components: null,
        traits: null,
        customImageUrl: null,
      });
    }
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EmailChannelSection />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  test("keeps the section's own title while the flag is off", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: false });
    renderSection(makeSubscription(false));

    expect(screen.getByRole("heading", { name: "Email" })).toBeTruthy();
    expect(screen.queryByText("Give your assistant an inbox")).toBeNull();
  });

  test("an org without managed email gets the inbox pitch as the header", () => {
    useClientFeatureFlagStore.setState({ assistantInbox: true });
    renderSection(makeSubscription(false));

    expect(
      screen.getByRole("heading", { name: "Give your assistant an inbox" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Email" })).toBeNull();
    expect(
      screen.queryByText(
        "Configure how your assistant sends and receives email",
      ),
    ).toBeNull();
    // One heading: the section's. The body brings no title of its own.
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    // The pitch's perks stand in for the address itself.
    expect(screen.getByText("A real address on local.vellum.me")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Upgrade to Super/ }),
    ).toBeTruthy();
  });
});
