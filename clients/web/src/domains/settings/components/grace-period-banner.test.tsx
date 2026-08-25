import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as platformDetection from "@/runtime/platform-detection";
import * as runtimeBrowser from "@/runtime/browser";
import { organizationsBillingSubscriptionRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";

let nativeAndroid = false;
mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  useIsNativeAndroid: () => nativeAndroid,
}));

let openedUrl: string | null = null;
mock.module("@/runtime/browser", () => ({
  ...runtimeBrowser,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
  openUrlFinishedListener: () => () => {},
}));

function gracePeriodSubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: "2026-09-01T00:00:00Z",
    cancel_at_period_end: true,
    cancel_at: "2026-09-01T00:00:00Z",
    package: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

// The reactivate endpoint clears the pending cancellation server-side; the
// retrieve mock serves the post-invalidate refetch with whatever state the
// "server" currently holds. The portal-session mock backs the fallback for
// subscriptions the reactivate endpoint rejects.
const PORTAL_URL = "https://stripe.test/portal/session";
let serverSubscription = gracePeriodSubscription();
let reactivateCalls = 0;
let portalCalls = 0;
mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionReactivateCreate: () => {
    reactivateCalls += 1;
    serverSubscription = {
      ...serverSubscription,
      cancel_at_period_end: false,
      cancel_at: null,
    };
    return Promise.resolve({
      data: { status: "ok", current_period_end: "2026-09-01T00:00:00Z" },
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({ data: serverSubscription, response: { ok: true } }),
  organizationsBillingPortalSessionCreate: () => {
    portalCalls += 1;
    return Promise.resolve({
      data: { portal_url: PORTAL_URL },
      response: { ok: true },
    });
  },
}));

const { GracePeriodBanner } = await import("./grace-period-banner");

function renderBanner(subscription: SubscriptionResponse = serverSubscription) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  return render(
    <QueryClientProvider client={client}>
      <GracePeriodBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  nativeAndroid = false;
  openedUrl = null;
  reactivateCalls = 0;
  portalCalls = 0;
  serverSubscription = gracePeriodSubscription();
});

afterEach(cleanup);

describe("GracePeriodBanner Reactivate", () => {
  test("posts the reactivate endpoint and clears the banner", async () => {
    const { getByTestId, queryByTestId } = renderBanner();

    fireEvent.click(getByTestId("grace-period-reactivate-button"));

    await waitFor(() => expect(reactivateCalls).toBe(1));
    // The hook invalidates the subscription read; the refetched state has no
    // pending cancellation, so the banner unmounts.
    await waitFor(() =>
      expect(queryByTestId("grace-period-banner")).toBeNull(),
    );
    expect(openedUrl).toBeNull();
    expect(portalCalls).toBe(0);
  });

  test("opens the Stripe portal for subscriptions the endpoint rejects", async () => {
    serverSubscription = { ...gracePeriodSubscription(), status: "unpaid" };
    const { getByTestId } = renderBanner();

    fireEvent.click(getByTestId("grace-period-reactivate-button"));

    await waitFor(() => expect(openedUrl).toBe(PORTAL_URL));
    expect(portalCalls).toBe(1);
    expect(reactivateCalls).toBe(0);
  });

  test("native Android opens the web billing page instead of the endpoint", async () => {
    nativeAndroid = true;
    const { getByTestId } = renderBanner();

    fireEvent.click(getByTestId("grace-period-reactivate-button"));

    await waitFor(() =>
      expect(openedUrl).toBe(
        `${window.location.origin}/assistant/settings/usage?tab=billing`,
      ),
    );
    expect(reactivateCalls).toBe(0);
    expect(portalCalls).toBe(0);
  });
});
