import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { Assistant } from "@/assistant/api";
import {
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";

let nativeAndroid = false;

mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => nativeAndroid,
  useIsNativeAndroid: () => nativeAndroid,
}));

const { ResizeCard } = await import(
  "@/domains/settings/components/resize-card"
);

const assistant = {
  id: "assistant-1",
  is_local: false,
  machine_size: "small",
} as Assistant;

function subscription(planId: SubscriptionResponse["plan_id"]): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

function renderCard(planId: SubscriptionResponse["plan_id"]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription(planId),
  );
  if (planId === "pro") {
    client.setQueryData(
      organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      {
        max_machine_tier: "large",
        selected_storage_tier: "s",
        selected_storage_gib: 10,
        pvc_ready: true,
        domain_setup_available: false,
        primary_assistant_id: assistant.id,
      },
    );
  }

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ResizeCard
          assistant={assistant}
          healthz={null}
          healthzLoading={false}
          healthzPolling={false}
          refetch={() => {}}
          refetchUntilResized={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  nativeAndroid = false;
});

afterEach(() => {
  cleanup();
});

describe("ResizeCard billing actions", () => {
  test("native Android keeps the Base plan resize entry points, same as iOS", () => {
    nativeAndroid = true;
    renderCard("base");

    // Both the disk and machine rows carry the Base plan's resize action.
    expect(
      screen.getAllByRole("button", { name: "Resize" }).length,
    ).toBeGreaterThan(0);
  });

  test("native Android keeps the Pro resize modal's upgrade link, same as iOS", () => {
    nativeAndroid = true;
    renderCard("pro");

    fireEvent.click(screen.getByRole("button", { name: "Increase Size" }));

    expect(screen.getByText("Resize Assistant")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upgrade plan" })).toBeTruthy();
  });
});
