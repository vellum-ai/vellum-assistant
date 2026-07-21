/**
 * Interaction tests for the useProProvisioning polling hook.
 *
 * Strategy mirrors plans-page-checkout.test.tsx: mock the generated SDK with
 * mutable responses, render a probe component inside a QueryClientProvider,
 * and drive the polls deterministically with queryClient.invalidateQueries()
 * instead of waiting out real refetch intervals.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  Assistant,
  OnboardingStateResponse,
  OperationalStatus,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import type { ProProvisioningResult } from "./use-pro-provisioning";

import * as proOnboardingUtils from "./utils";

/** Shrunk so confirm-timeout reachability doesn't wait out the real 10s poll. */
const TEST_CONFIRM_TIMEOUT_MS = 800;

mock.module("./utils", () => ({
  ...proOnboardingUtils,
  PRO_POLL_TIMEOUT_MS: TEST_CONFIRM_TIMEOUT_MS,
}));

// Stall detection compares wall-clock time against the 90s threshold; the
// stall tests jump this offset instead of waiting it out.
const realDateNow = Date.now.bind(Date);
let dateNowOffsetMs = 0;
Date.now = () => realDateNow() + dateNowOffsetMs;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
/** Per-id overrides for the by-id retrieve; falls back to assistantResponse. */
let assistantsById: Record<string, Assistant> = {};
let operationalStatusResponse = makeOperationalStatus("active");
let assistantEndpointsFail = false;
let onboardingFails = false;
/** Holds the onboarding fetch in flight so isFetching can be observed. */
let onboardingGate: Deferred | null = null;
let assistantCalls = 0;
let assistantByIdCalls = 0;
let operationalStatusCalls = 0;
let subscriptionCalls = 0;
let isOrgReadyMock = true;
let fetchOrganizationsCalls = 0;

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => isOrgReadyMock,
}));

mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({
      fetchOrganizations: () => {
        fetchOrganizationsCalls += 1;
        return Promise.resolve();
      },
    }),
  },
}));

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionRetrieve: () => {
    subscriptionCalls += 1;
    return Promise.resolve({
      data: makeSubscription(subscriptionPlanId),
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionOnboardingRetrieve: async () => {
    if (onboardingFails) {
      throw new Error("500 Internal Server Error");
    }
    if (onboardingGate) {
      await onboardingGate.promise;
    }
    return { data: onboardingResponse, response: { ok: true } };
  },
  assistantsActiveRetrieve: () => {
    assistantCalls += 1;
    if (assistantEndpointsFail) {
      return Promise.reject(new Error("502 Bad Gateway"));
    }
    return Promise.resolve({ data: assistantResponse, response: { ok: true } });
  },
  assistantsRetrieve: (opts: { path: { id: string } }) => {
    assistantByIdCalls += 1;
    if (assistantEndpointsFail) {
      return Promise.reject(new Error("502 Bad Gateway"));
    }
    return Promise.resolve({
      data: assistantsById[opts.path.id] ?? assistantResponse,
      response: { ok: true },
    });
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

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderProbe(client = makeClient()) {
  const ui = () => (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { client, rerender: () => view.rerender(ui()) };
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
  assistantsById = {};
  operationalStatusResponse = makeOperationalStatus("active");
  assistantEndpointsFail = false;
  onboardingFails = false;
  onboardingGate = null;
  assistantCalls = 0;
  assistantByIdCalls = 0;
  operationalStatusCalls = 0;
  subscriptionCalls = 0;
  isOrgReadyMock = true;
  fetchOrganizationsCalls = 0;
  dateNowOffsetMs = 0;
  latest = null;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  Date.now = realDateNow;
});

describe("useProProvisioning", () => {
  test("progresses CONFIRMING → WAITING → RESIZING → DONE as polls land", async () => {
    const { client } = renderProbe();
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
  });

  test("resize completing between polls (never observed) → DONE, not NOT_APPLICABLE", async () => {
    const { client } = renderProbe();
    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));

    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });
    // Below-target actuals must be frozen as the snapshot before the jump.
    await waitFor(() =>
      expect(latest!.actualsSnapshot).toEqual({
        machineSize: "small",
        storageGib: 10,
      }),
    );

    // The resize starts and finishes entirely between two polls, so the
    // operational status never reports it — actuals just jump to the targets.
    assistantResponse = makeAssistant("large", 50);
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });
    expect(latest!.actualsSnapshot).toEqual({
      machineSize: "small",
      storageGib: 10,
    });
  });

  test("transient 5xx from assistant endpoints during RESIZING does not error", async () => {
    const { client } = renderProbe();
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

  test(
    "polling stops once DONE",
    async () => {
      const { client } = renderProbe();
      await reachResizing(client);

      assistantResponse = makeAssistant("large", 50);
      operationalStatusResponse = makeOperationalStatus("active");
      await refetchAll(client);
      await waitFor(() => expect(latest!.state).toBe("DONE"), {
        timeout: 5000,
      });

      // One clock tick may still be in flight when DONE lands; let it drain,
      // then assert no further polls fire across a full poll interval.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const settledAssistantCalls = assistantCalls;
      const settledByIdCalls = assistantByIdCalls;
      const settledStatusCalls = operationalStatusCalls;
      const settledSubscriptionCalls = subscriptionCalls;
      await new Promise((resolve) => setTimeout(resolve, 2600));

      expect(assistantCalls).toBe(settledAssistantCalls);
      expect(assistantByIdCalls).toBe(settledByIdCalls);
      expect(operationalStatusCalls).toBe(settledStatusCalls);
      expect(subscriptionCalls).toBe(settledSubscriptionCalls);
      expect(latest!.state).toBe("DONE");
    },
    20_000,
  );

  test(
    "resumeAfterManualApply leaves STALLED for RESIZING and can reach DONE",
    async () => {
      const { client } = renderProbe();
      await reachResizing(client);

      // Jump the wall clock past the stall threshold; the next 1s clock tick
      // re-derives the state as STALLED.
      dateNowOffsetMs = 200_000;
      await waitFor(() => expect(latest!.state).toBe("STALLED"), {
        timeout: 5000,
      });

      act(() => latest!.resumeAfterManualApply());
      await waitFor(() => expect(latest!.state).toBe("RESIZING"));

      assistantResponse = makeAssistant("large", 50);
      await refetchAll(client);
      await waitFor(() => expect(latest!.state).toBe("DONE"), {
        timeout: 5000,
      });
    },
    20_000,
  );

  test(
    "STALLED keeps polling and self-recovers to DONE when the resize lands late",
    async () => {
      const { client } = renderProbe();
      await reachResizing(client);

      dateNowOffsetMs = 200_000;
      await waitFor(() => expect(latest!.state).toBe("STALLED"), {
        timeout: 5000,
      });

      // STALLED is not terminal: the actuals polls keep firing so a
      // late-completing server resize can still be observed.
      const stalledByIdCalls = assistantByIdCalls;
      await waitFor(
        () => expect(assistantByIdCalls).toBeGreaterThan(stalledByIdCalls),
        { timeout: 5000 },
      );

      // The resize lands with no manual apply — the flow self-recovers.
      assistantResponse = makeAssistant("large", 50);
      await refetchAll(client);
      await waitFor(() => expect(latest!.state).toBe("DONE"), {
        timeout: 5000,
      });
    },
    20_000,
  );

  test(
    "escapeEligible flips after the escape window and re-bases on manual-apply resume",
    async () => {
      const { client } = renderProbe();
      await reachResizing(client);
      expect(latest!.escapeEligible).toBe(false);

      // Past the 60s escape window but under the 90s stall threshold.
      dateNowOffsetMs = 61_000;
      await waitFor(() => expect(latest!.escapeEligible).toBe(true), {
        timeout: 5000,
      });
      expect(latest!.state).toBe("RESIZING");

      dateNowOffsetMs = 200_000;
      await waitFor(() => expect(latest!.state).toBe("STALLED"), {
        timeout: 5000,
      });
      expect(latest!.escapeEligible).toBe(true);

      // The resume re-bases the watch clock, so eligibility starts over.
      act(() => latest!.resumeAfterManualApply());
      await waitFor(() => expect(latest!.escapeEligible).toBe(false));
      expect(latest!.state).toBe("RESIZING");
    },
    20_000,
  );

  test("org-scoped queries hold until the org id is available", async () => {
    isOrgReadyMock = false;
    const { rerender } = renderProbe();

    await waitFor(() => expect(latest).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(subscriptionCalls).toBe(0);
    expect(latest!.state).toBe("CONFIRMING");
    expect(latest!.confirmError).toBe(false);

    isOrgReadyMock = true;
    subscriptionPlanId = "pro";
    rerender();
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });
    expect(subscriptionCalls).toBeGreaterThan(0);
  });

  test("org never ready: confirm timeout still fires and retry kicks the org fetch", async () => {
    isOrgReadyMock = false;
    renderProbe();

    // The confirm timer runs regardless of org readiness, so a wedged org
    // hydration still lands on the payment-safe retry screen.
    await waitFor(() => expect(latest!.state).toBe("CONFIRM_TIMEOUT"), {
      timeout: TEST_CONFIRM_TIMEOUT_MS + 3000,
    });
    expect(subscriptionCalls).toBe(0);

    // Retry also refetches the org list so it can heal a failed hydration.
    act(() => latest!.retryConfirm());
    expect(fetchOrganizationsCalls).toBe(1);
    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
  });

  test("reopen with a stale cached pro plan never confirms from cache", async () => {
    const client = makeClient();
    // A pre-downgrade "pro" response is still cached from an earlier session
    // of the wizard; the live subscription is back on base.
    client.setQueryData(
      organizationsBillingSubscriptionRetrieveQueryKey(),
      makeSubscription("pro"),
      { updatedAt: realDateNow() - 60_000 },
    );
    subscriptionPlanId = "base";
    renderProbe(client);

    // The on-open refetch lands base; the stale cached pro must not latch.
    await waitFor(() => expect(subscriptionCalls).toBeGreaterThan(0));
    expect(latest!.state).toBe("CONFIRMING");
    expect(latest!.targets).toBeNull();

    // No wedge: the flow still reaches the payment-safe timeout screen.
    await waitFor(() => expect(latest!.state).toBe("CONFIRM_TIMEOUT"), {
      timeout: TEST_CONFIRM_TIMEOUT_MS + 3000,
    });
    expect(latest!.targets).toBeNull();
  });

  test("assistantId prefers the onboarding primary assistant over the active one", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = {
      ...makeOnboarding(),
      primary_assistant_id: "assistant-2",
    };
    renderProbe();

    await waitFor(() => expect(latest!.assistantId).toBe("assistant-2"), {
      timeout: 5000,
    });
  });

  test("assistantId falls back to the active assistant without a primary", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = { ...makeOnboarding(), primary_assistant_id: null };
    renderProbe();

    await waitFor(() => expect(latest!.assistantId).toBe("assistant-1"), {
      timeout: 5000,
    });
  });

  test("actuals track the primary assistant, not the active one", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = {
      ...makeOnboarding(),
      primary_assistant_id: "assistant-2",
    };
    // The active assistant already satisfies the targets; judging DONE against
    // it would falsely complete while the primary is still being resized.
    assistantResponse = makeAssistant("large", 50);
    assistantsById["assistant-2"] = {
      ...makeAssistant("small", 10),
      id: "assistant-2",
    };
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.assistantId).toBe("assistant-2"), {
      timeout: 5000,
    });
    await waitFor(
      () =>
        expect(latest!.actualsSnapshot).toEqual({
          machineSize: "small",
          storageGib: 10,
        }),
      { timeout: 5000 },
    );
    expect(latest!.state).toBe("WAITING");

    // The resize lands on the primary — only then does the wizard converge.
    assistantsById["assistant-2"] = {
      ...makeAssistant("large", 50),
      id: "assistant-2",
    };
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });
  });

  test(
    "reopen with a stale cached onboarding primary tracks the fresh assistant, not the stale one",
    async () => {
      const client = makeClient();
      // Hold the on-open onboarding refetch in flight so react-query keeps
      // serving the stale cached payload (isFetching true, isPending false).
      const gate = makeDeferred();
      onboardingGate = gate;
      // A prior wizard session cached onboarding naming assistant-A, which is
      // already at the purchased targets — the trap the fence must avoid.
      client.setQueryData(
        organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
        { ...makeOnboarding(), primary_assistant_id: "assistant-A" },
        { updatedAt: realDateNow() - 60_000 },
      );
      subscriptionPlanId = "pro";
      // The fresh payload names assistant-B, which is still below the targets.
      onboardingResponse = {
        ...makeOnboarding(),
        primary_assistant_id: "assistant-B",
      };
      assistantResponse = {
        ...makeAssistant("small", 10),
        id: "assistant-active",
      };
      assistantsById["assistant-A"] = {
        ...makeAssistant("large", 50),
        id: "assistant-A",
      };
      assistantsById["assistant-B"] = {
        ...makeAssistant("small", 10),
        id: "assistant-B",
      };
      renderProbe(client);

      // While the refetch is in flight the stale primary (assistant-A) must not
      // drive the polls; the hook falls back to the active assistant and never
      // latches assistant-A's already-at-target (NOT_APPLICABLE) verdict.
      await waitFor(
        () => expect(latest!.assistantId).toBe("assistant-active"),
        { timeout: 5000 },
      );
      expect(latest!.state).toBe("WAITING");

      // Release the refetch: the freshly-settled primary (B, below target) now
      // drives the polls and freezes the snapshot against B.
      await act(async () => {
        gate.resolve();
        await gate.promise;
      });
      await waitFor(() => expect(latest!.assistantId).toBe("assistant-B"), {
        timeout: 5000,
      });
      await waitFor(
        () =>
          expect(latest!.actualsSnapshot).toEqual({
            machineSize: "small",
            storageGib: 10,
          }),
        { timeout: 5000 },
      );
      expect(latest!.state).toBe("WAITING");

      // The resize lands on B: because the snapshot tracks B's below-target
      // "from", the flow converges to DONE rather than NOT_APPLICABLE off A.
      assistantsById["assistant-B"] = {
        ...makeAssistant("large", 50),
        id: "assistant-B",
      };
      await refetchAll(client);
      await waitFor(() => expect(latest!.state).toBe("DONE"), {
        timeout: 5000,
      });
    },
    20_000,
  );

  test(
    "assistantId changing mid-open re-captures the snapshot against the new assistant",
    async () => {
      subscriptionPlanId = "pro";
      onboardingResponse = {
        ...makeOnboarding(),
        primary_assistant_id: "assistant-1",
      };
      // assistant-1 starts below the large/50 targets; assistant-2 is already
      // fully provisioned before the wizard ever observes it.
      assistantsById["assistant-1"] = {
        ...makeAssistant("small", 10),
        id: "assistant-1",
      };
      assistantsById["assistant-2"] = {
        ...makeAssistant("large", 50),
        id: "assistant-2",
      };
      const { client } = renderProbe();

      await waitFor(() => expect(latest!.assistantId).toBe("assistant-1"), {
        timeout: 5000,
      });
      await waitFor(
        () =>
          expect(latest!.actualsSnapshot).toEqual({
            machineSize: "small",
            storageGib: 10,
          }),
        { timeout: 5000 },
      );
      expect(latest!.state).toBe("WAITING");

      // The fresh onboarding payload re-targets the wizard at assistant-2.
      onboardingResponse = {
        ...makeOnboarding(),
        primary_assistant_id: "assistant-2",
      };
      await refetchAll(client);
      await waitFor(() => expect(latest!.assistantId).toBe("assistant-2"), {
        timeout: 5000,
      });

      // The "from" snapshot re-keys to assistant-2's own actuals. A stale
      // assistant-1 snapshot ({small,10}) would make an already-provisioned
      // assistant-2 look freshly resized (DONE); tracking the correct "from"
      // reads it as NOT_APPLICABLE.
      await waitFor(
        () =>
          expect(latest!.actualsSnapshot).toEqual({
            machineSize: "large",
            storageGib: 50,
          }),
        { timeout: 5000 },
      );
      expect(latest!.state).toBe("NOT_APPLICABLE");
    },
    20_000,
  );

  test("unknown machine tier from a newer backend yields no machine target", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = { ...makeOnboarding(), max_machine_tier: "xxl" };
    renderProbe();

    // A null machine target is treated as satisfied (skew-safe): the storage
    // dimension alone drives the flow.
    await waitFor(
      () =>
        expect(latest!.targets).toEqual({ machineSize: null, storageGib: 50 }),
      { timeout: 5000 },
    );
    expect(latest!.state).toBe("WAITING");
  });

  test("onboarding fetch failure after confirm sets targetsError", async () => {
    subscriptionPlanId = "pro";
    onboardingFails = true;
    renderProbe();

    await waitFor(() => expect(latest!.targetsError).toBe(true), {
      timeout: 5000,
    });
    expect(latest!.confirmError).toBe(false);
    expect(latest!.targets).toBeNull();
  });

  test("onboarding refetch failure with cached targets does not set targetsError", async () => {
    const { client } = renderProbe();
    await reachResizing(client);

    onboardingFails = true;
    await refetchAll(client);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(latest!.targetsError).toBe(false);
    expect(latest!.targets).toEqual({ machineSize: "large", storageGib: 50 });
    expect(latest!.state).toBe("RESIZING");
  });
});
