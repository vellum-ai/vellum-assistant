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

const PORTAL_URL = "https://stripe.test/portal/session";
let portalCalls = 0;
mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingPortalSessionCreate: () => {
    portalCalls += 1;
    return Promise.resolve({
      data: { portal_url: PORTAL_URL },
      response: { ok: true },
    });
  },
}));

const { GracePeriodBanner } = await import("./grace-period-banner");

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

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    gracePeriodSubscription(),
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
  portalCalls = 0;
});

afterEach(cleanup);

describe("GracePeriodBanner Reactivate", () => {
  test("opens the Stripe billing portal off Android", async () => {
    const { getByTestId } = renderBanner();

    fireEvent.click(getByTestId("grace-period-reactivate-button"));

    await waitFor(() => expect(openedUrl).toBe(PORTAL_URL));
    expect(portalCalls).toBe(1);
  });

  test("native Android opens the web billing page instead of a portal session", async () => {
    nativeAndroid = true;
    const { getByTestId } = renderBanner();

    fireEvent.click(getByTestId("grace-period-reactivate-button"));

    await waitFor(() =>
      expect(openedUrl).toBe(
        `${window.location.origin}/assistant/settings/usage?tab=billing`,
      ),
    );
    expect(portalCalls).toBe(0);
  });
});
