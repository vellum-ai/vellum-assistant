/**
 * Interaction tests for the useProProvisioning polling hook.
 *
 * Strategy mirrors plans-page-checkout.test.tsx: mock the generated SDK with
 * mutable responses, render a probe component inside a QueryClientProvider,
 * and drive the polls deterministically with queryClient.invalidateQueries()
 * instead of waiting out real refetch intervals.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  Assistant,
  OnboardingStateResponse,
  OperationalStatus,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import type { ProProvisioningResult } from "./use-pro-provisioning";

function makeSubscription(
  planId: SubscriptionResponse["plan_id"],
): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_end: "2026-08-01T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

function makeOnboarding(): OnboardingStateResponse {
  return {
    max_machine_tier: "large",
    selected_storage_tier: "md",
    selected_storage_gib: 50,
    pvc_ready: false,
    domain_setup_available: true,
    primary_assistant_id: "assistant-1",
  };
}

function makeAssistant(
  machineSize: Assistant["machine_size"],
  storageGib: number | null,
): Assistant {
  return {
    id: "assistant-1",
    machine_size: machineSize,
    provisioned_storage_gib: storageGib,
  } as Assistant;
}

function makeOperationalStatus(
  state: OperationalStatus["state"],
): OperationalStatus {
  return {
    state,
    detail_state: state,
    poll_after_ms: 5000,
    updated_at: "2026-08-01T00:00:00Z",
    state_started_at: null,
    active_operation: null,
    storage: null,
    detail: { reason: null, message: null },
  } as OperationalStatus;
}

let subscriptionPlanId: SubscriptionResponse["plan_id"] = "base";
let onboardingResponse = makeOnboarding();
let assistantResponse = makeAssistant("small", 10);
let operationalStatusResponse = makeOperationalStatus("active");
let assistantEndpointsFail = false;
let assistantCalls = 0;
let operationalStatusCalls = 0;
let subscriptionCalls = 0;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionRetrieve: () => {
    subscriptionCalls += 1;
    return Promise.resolve({
      data: makeSubscription(subscriptionPlanId),
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionOnboardingRetrieve: () =>
    Promise.resolve({ data: onboardingResponse, response: { ok: true } }),
  assistantsActiveRetrieve: () => {
    assistantCalls += 1;
    if (assistantEndpointsFail) {
      return Promise.reject(new Error("502 Bad Gateway"));
    }
    return Promise.resolve({ data: assistantResponse, response: { ok: true } });
  },
  assistantsOperationalStatusDetailRead: () => {
    operationalStatusCalls += 1;
    if (assistantEndpointsFail) {
      return Promise.reject(new Error("502 Bad Gateway"));
    }
    return Promise.resolve({
      data: operationalStatusResponse,
      response: { ok: true },
    });
  },
}));

const { useProProvisioning } = await import("./use-pro-provisioning");

let latest: ProProvisioningResult | null = null;

function Probe() {
  const result = useProProvisioning({ open: true });
  useEffect(() => {
    latest = result;
  });
  return null;
}

function renderProbe() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return client;
}

async function refetchAll(client: QueryClient) {
  await client.invalidateQueries();
}

/** Drive the hook from a fresh mount to a confirmed-pro RESIZING state. */
async function reachResizing(client: QueryClient) {
  await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));

  subscriptionPlanId = "pro";
  await refetchAll(client);
  await waitFor(() => expect(latest!.state).toBe("WAITING"), {
    timeout: 5000,
  });

  operationalStatusResponse = makeOperationalStatus("resizing_machine");
  await refetchAll(client);
  await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
    timeout: 5000,
  });
}

beforeEach(() => {
  subscriptionPlanId = "base";
  onboardingResponse = makeOnboarding();
  assistantResponse = makeAssistant("small", 10);
  operationalStatusResponse = makeOperationalStatus("active");
  assistantEndpointsFail = false;
  assistantCalls = 0;
  operationalStatusCalls = 0;
  subscriptionCalls = 0;
  latest = null;
});

afterEach(() => {
  cleanup();
});

describe("useProProvisioning", () => {
  test("progresses CONFIRMING → WAITING → RESIZING → DONE as polls land", async () => {
    const client = renderProbe();
    await reachResizing(client);

    expect(latest!.targets).toEqual({ machineSize: "large", storageGib: 50 });
    // First actuals observed are frozen as the before/after "from" side.
    expect(latest!.actualsSnapshot).toEqual({
      machineSize: "small",
      storageGib: 10,
    });

    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });

    // The snapshot must not be mutated by later polls.
    expect(latest!.actualsSnapshot).toEqual({
      machineSize: "small",
      storageGib: 10,
    });
    expect(latest!.confirmError).toBe(false);
    expect(latest!.confirmExpired).toBe(false);
  });

  test("transient 5xx from assistant endpoints during RESIZING does not error", async () => {
    const client = renderProbe();
    await reachResizing(client);

    assistantEndpointsFail = true;
    await refetchAll(client);
    // Give the rejected refetches time to settle into query error state.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(latest!.state).toBe("RESIZING");
    expect(latest!.confirmError).toBe(false);
    expect(latest!.actualsSnapshot).toEqual({
      machineSize: "small",
      storageGib: 10,
    });

    // The pod comes back with the resize applied — the hook recovers to DONE.
    assistantEndpointsFail = false;
    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });
  });

  test("polling stops once DONE", async () => {
    const client = renderProbe();
    await reachResizing(client);

    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });

    // One clock tick may still be in flight when DONE lands; let it drain,
    // then assert no further polls fire across a full poll interval.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const settledAssistantCalls = assistantCalls;
    const settledStatusCalls = operationalStatusCalls;
    const settledSubscriptionCalls = subscriptionCalls;
    await new Promise((resolve) => setTimeout(resolve, 2600));

    expect(assistantCalls).toBe(settledAssistantCalls);
    expect(operationalStatusCalls).toBe(settledStatusCalls);
    expect(subscriptionCalls).toBe(settledSubscriptionCalls);
    expect(latest!.state).toBe("DONE");
  });
});
