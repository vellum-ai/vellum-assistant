/**
 * Interaction tests for the useProProvisioning polling hook.
 *
 * Strategy mirrors plans-page-checkout.test.tsx: mock the generated SDK with
 * mutable responses, render a probe component inside a QueryClientProvider,
 * and drive the polls deterministically with queryClient.invalidateQueries()
 * instead of waiting out real refetch intervals.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { useEffect, useLayoutEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  assistantsOperationalStatusDetailReadQueryKey,
  assistantsRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  Assistant,
  EnsureProvisionedResponse,
  OnboardingStateResponse,
  OperationalStatus,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import type { ProProvisioningResult } from "./use-pro-provisioning";

import * as proOnboardingUtils from "./utils";

/** Shrunk so confirm-timeout reachability doesn't wait out the real 10s poll. */
const TEST_CONFIRM_TIMEOUT_MS = 800;
/** Shrunk so the no_active_pro race retry doesn't wait out the real 2s. */
const TEST_RACE_RETRY_MS = 150;

mock.module("./utils", () => ({
  ...proOnboardingUtils,
  PRO_POLL_TIMEOUT_MS: TEST_CONFIRM_TIMEOUT_MS,
  ENSURE_PROVISIONED_RACE_RETRY_MS: TEST_RACE_RETRY_MS,
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
    current_period_start: null,
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

/** A settled state carrying an in-flight resize marker for one dimension. */
function makeResizeOperationStatus(
  operation: "resize_machine" | "resize_storage",
): OperationalStatus {
  return {
    ...makeOperationalStatus("active"),
    active_operation: {
      operation,
      operation_id: "op-1",
      phase: "waiting_for_ready",
      started_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      target: {},
    },
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
/** Holds the operational-status fetch in flight, mid-poll. */
let operationalStatusGate: Deferred | null = null;
let assistantCalls = 0;
let assistantByIdCalls = 0;
let operationalStatusCalls = 0;
let subscriptionCalls = 0;
let isOrgReadyMock = true;
let fetchOrganizationsCalls = 0;
let ensureCalls = 0;
/**
 * The ensure-provisioned response is *held in flight* by default so the
 * inference-path tests below keep observing the exact WAITING → RESIZING
 * sequence they always have (a verdict resolving mid-sequence would race
 * them). Verdict tests opt in by assigning `ensureResponse`/`ensureError`.
 */
let ensureResponse: EnsureProvisionedResponse | null = null;
let ensureError: unknown = null;
/**
 * When set, every reconcile call parks in `pendingEnsures` so a test can settle
 * one specific call by hand — the only way to land a response at a chosen point
 * in the open/close lifecycle.
 */
let ensureDeferred = false;
let pendingEnsures: {
  resolve: (data: EnsureProvisionedResponse) => void;
  reject: (error: unknown) => void;
}[] = [];

function makeEnsureResponse(
  state: EnsureProvisionedResponse["state"],
  reason: EnsureProvisionedResponse["reason"] = null,
): EnsureProvisionedResponse {
  return {
    state,
    reason,
    targets: { machine_size: "large", storage_gib: 50 },
  };
}

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
  assistantsOperationalStatusDetailRead: async () => {
    operationalStatusCalls += 1;
    if (assistantEndpointsFail) {
      throw new Error("502 Bad Gateway");
    }
    // Read at request time, so a gated fetch answers with the reading the
    // server held when it started rather than one written while it was out.
    const data = operationalStatusResponse;
    if (operationalStatusGate) {
      await operationalStatusGate.promise;
    }
    return { data, response: { ok: true } };
  },
  organizationsBillingSubscriptionOnboardingEnsureProvisionedCreate: () => {
    ensureCalls += 1;
    if (ensureDeferred) {
      return new Promise((resolve, reject) => {
        pendingEnsures.push({
          resolve: (data: EnsureProvisionedResponse) =>
            resolve({ data, response: { ok: true } }),
          reject,
        });
      });
    }
    if (ensureError != null) {
      return Promise.reject(ensureError);
    }
    if (!ensureResponse) {
      // Held in flight — see the `ensureResponse` docstring.
      return new Promise(() => {});
    }
    return Promise.resolve({ data: ensureResponse, response: { ok: true } });
  },
}));

const { useProProvisioning } = await import("./use-pro-provisioning");

let latest: ProProvisioningResult | null = null;

/**
 * Run from the probe's layout effect, which fires after a render commits and
 * before the hook's passive effects. The seam a test needs to start a request
 * inside that window; it clears itself when it has fired.
 */
let onLayoutCommit: (() => void) | null = null;

function Probe({
  open = true,
  canLowerResources = false,
  verdictRecheckMs,
}: {
  open?: boolean;
  canLowerResources?: boolean;
  verdictRecheckMs?: number;
}) {
  const result = useProProvisioning({
    open,
    canLowerResources,
    verdictRecheckMs,
  });
  useLayoutEffect(() => {
    onLayoutCommit?.();
  });
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

function renderProbe(
  client = makeClient(),
  canLowerResources = false,
  verdictRecheckMs?: number,
) {
  const ui = (open = true) => (
    <QueryClientProvider client={client}>
      <Probe
        open={open}
        canLowerResources={canLowerResources}
        verdictRecheckMs={verdictRecheckMs}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return {
    client,
    rerender: () => view.rerender(ui()),
    /** Close/reopen the wizard without unmounting the hook. */
    setOpen: (open: boolean) => view.rerender(ui(open)),
  };
}

async function refetchAll(client: QueryClient) {
  await client.invalidateQueries();
}

/**
 * Write to the cache and let the notification reach React. The query cache
 * schedules its notifications on a timer, so an `act` that only drains
 * microtasks can return before the render the write implies has happened.
 */
async function commitCacheWrite(write: () => void) {
  await act(async () => {
    write();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const ASSISTANT_QUERY_KEY = assistantsRetrieveQueryKey({
  path: { id: "assistant-1" },
});
const STATUS_QUERY_KEY = assistantsOperationalStatusDetailReadQueryKey({
  path: { id: "assistant-1" },
});

/**
 * Take operational-status readings until `check` passes. A landed flag holds
 * its dimension pending until the status has been read since that dimension met
 * its target, and terminal states stop the hook's own poll, so the readings are
 * taken by hand rather than waited out.
 */
async function waitForLanded(client: QueryClient, check: () => void) {
  await waitFor(
    async () => {
      await client.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      check();
    },
    { timeout: 5000 },
  );
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
  operationalStatusGate = null;
  assistantCalls = 0;
  assistantByIdCalls = 0;
  operationalStatusCalls = 0;
  subscriptionCalls = 0;
  isOrgReadyMock = true;
  fetchOrganizationsCalls = 0;
  ensureCalls = 0;
  ensureResponse = null;
  ensureError = null;
  ensureDeferred = false;
  pendingEnsures = [];
  dateNowOffsetMs = 0;
  latest = null;
  onLayoutCommit = null;
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

  test("polling stops once DONE", async () => {
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
  }, 20_000);

  test("a started verdict needs a status reading taken after the target actuals", async () => {
    // The marker is created by a background worker, so a status read taken
    // right after a `started` verdict can predate it entirely. The status is
    // held at `active` throughout here, so `sawOperation` never latches and
    // the anchor is the only thing that can complete the flow.
    ensureResponse = makeEnsureResponse("started");
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });

    // Targets now read as met, but no status reading has been taken since.
    assistantResponse = makeAssistant("large", 50);
    await refetchAll(client);
    const callsAtTargetsMet = operationalStatusCalls;
    expect(latest!.state).not.toBe("DONE");

    // A later status poll is what actually settles it.
    await waitFor(() => expect(latest!.state).toBe("DONE"), {
      timeout: 5000,
    });
    expect(operationalStatusCalls).toBeGreaterThan(callsAtTargetsMet);
  }, 20_000);

  test("a dead-end no_active_pro kick stays STALLED and surfaces why", async () => {
    // The auto reconcile consumes the once-per-open re-ask, so a later kick
    // that still gets no_active_pro can queue nothing and re-ask nothing.
    // Resuming the watch there would drop the user out of STALLED for another
    // stall window with no resize running.
    ensureResponse = makeEnsureResponse("not_applicable", "no_active_pro");
    const { client } = renderProbe();
    await reachResizing(client);

    dateNowOffsetMs = 200_000;
    await waitFor(() => expect(latest!.state).toBe("STALLED"), {
      timeout: 5000,
    });

    const callsBefore = ensureCalls;
    act(() => latest!.kickProvisioning());
    await waitFor(() => expect(ensureCalls).toBeGreaterThan(callsBefore));

    await waitFor(
      () =>
        expect(latest!.kickError).toEqual({
          error: "no_active_pro",
        }),
      { timeout: 5000 },
    );
    // Still STALLED, so the flow keeps polling for a self-recovery.
    expect(latest!.state).toBe("STALLED");
  }, 20_000);

  test("the escape kick re-calls ensure-provisioned, leaves STALLED and can reach DONE", async () => {
    const { client } = renderProbe();
    await reachResizing(client);
    const autoCalls = ensureCalls;

    // Jump the wall clock past the stall threshold; the next 1s clock tick
    // re-derives the state as STALLED.
    dateNowOffsetMs = 200_000;
    await waitFor(() => expect(latest!.state).toBe("STALLED"), {
      timeout: 5000,
    });

    // The reconcile answers "started": the verdict alone lifts the wizard
    // back to RESIZING and the success re-bases the stall clock.
    ensureResponse = makeEnsureResponse("started");
    act(() => latest!.kickProvisioning());
    await waitFor(() => expect(ensureCalls).toBe(autoCalls + 1));
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
    expect(latest!.kickError).toBeNull();

    // The landing resize also retires the operation marker: the platform
    // reports `resizing_machine` until the rollout converges, so met actuals
    // never coexist with an in-flight marker on a real completion.
    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), {
      timeout: 5000,
    });
  }, 20_000);

  test("a failed escape kick surfaces its error without leaving STALLED wedged", async () => {
    const { client } = renderProbe();
    await reachResizing(client);

    dateNowOffsetMs = 200_000;
    await waitFor(() => expect(latest!.state).toBe("STALLED"), {
      timeout: 5000,
    });

    ensureError = { error: "provisioning_submission_failed" };
    act(() => latest!.kickProvisioning());
    await waitFor(() =>
      expect(latest!.kickError).toEqual({
        error: "provisioning_submission_failed",
      }),
    );
    // A user-visible error, but not a terminal one: still STALLED, still
    // polling, so a late-landing resize recovers on its own.
    expect(latest!.state).toBe("STALLED");

    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), {
      timeout: 5000,
    });
  }, 20_000);

  test("STALLED keeps polling and self-recovers to DONE when the resize lands late", async () => {
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
    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), {
      timeout: 5000,
    });
  }, 20_000);

  test("escapeEligible flips after the escape window and re-bases on an escape-kick resume", async () => {
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

    // A successful escape kick re-bases the watch clock, so eligibility
    // starts over.
    ensureResponse = makeEnsureResponse("started");
    act(() => latest!.kickProvisioning());
    await waitFor(() => expect(latest!.escapeEligible).toBe(false), {
      timeout: 5000,
    });
    expect(latest!.state).toBe("RESIZING");
  }, 20_000);

  test("kickProvisioning fires the reconcile, captures kickError, and a success clears it", async () => {
    const { client } = renderProbe();
    await reachResizing(client);
    const autoCalls = ensureCalls;

    dateNowOffsetMs = 200_000;
    await waitFor(() => expect(latest!.state).toBe("STALLED"), {
      timeout: 5000,
    });

    // A fire-and-forget escape kick that fails captures kickError — a hung
    // escape-fired call must never strand later UI.
    ensureError = { error: "provisioning_submission_failed" };
    act(() => latest!.kickProvisioning());
    await waitFor(() => expect(ensureCalls).toBe(autoCalls + 1));
    await waitFor(() =>
      expect(latest!.kickError).toEqual({
        error: "provisioning_submission_failed",
      }),
    );
    // The failure is not terminal: still STALLED, still polling.
    expect(latest!.state).toBe("STALLED");

    // A subsequent successful escape kick clears kickError and re-bases the
    // stall clock — the `started` verdict lifts the wizard back to RESIZING.
    ensureError = null;
    ensureResponse = makeEnsureResponse("started");
    act(() => latest!.kickProvisioning());
    await waitFor(() => expect(ensureCalls).toBe(autoCalls + 2));
    await waitFor(() => expect(latest!.kickError).toBeNull());
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
  }, 20_000);

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

  test("the targets-met latch is re-keyed when the provisioning target changes", async () => {
    // Both assistants already satisfy the targets, so `currentTargetsMet`
    // never flips false across the switch. Without re-keying, the first
    // assistant's timestamp would survive and any status reading merely
    // postdating it could confirm a rollout for the second that nobody
    // observed. Status is held at `active` so `sawOperation` never latches.
    ensureResponse = makeEnsureResponse("started");
    subscriptionPlanId = "pro";
    onboardingResponse = { ...makeOnboarding(), primary_assistant_id: null };
    assistantResponse = makeAssistant("large", 50);
    assistantsById["assistant-2"] = {
      ...makeAssistant("large", 50),
      id: "assistant-2",
    };
    const { client } = renderProbe();

    // Settles on the active assistant and completes against it.
    await waitFor(() => expect(latest!.state).toBe("DONE"), {
      timeout: 5000,
    });

    // The primary lands and re-points the polls at a different assistant.
    onboardingResponse = {
      ...makeOnboarding(),
      primary_assistant_id: "assistant-2",
    };
    await refetchAll(client);
    await waitFor(() => expect(latest!.assistantId).toBe("assistant-2"), {
      timeout: 5000,
    });

    // The latch now describes assistant-2, so its confirmation had to come
    // from a status reading taken after *its* actuals were seen to meet the
    // targets — not from the previous assistant's stale timestamp.
    const callsAfterSwitch = operationalStatusCalls;
    await waitFor(() => expect(latest!.state).toBe("DONE"), {
      timeout: 5000,
    });
    expect(operationalStatusCalls).toBeGreaterThanOrEqual(callsAfterSwitch);
  }, 20_000);

  test("background onboarding refetch keeps the fresh primary selected (no flip to active)", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = {
      ...makeOnboarding(),
      primary_assistant_id: "assistant-2",
    };
    // The active assistant differs from the primary; a flip would re-target
    // the polls and re-key the snapshot against it.
    assistantResponse = {
      ...makeAssistant("small", 10),
      id: "assistant-active",
    };
    assistantsById["assistant-2"] = {
      ...makeAssistant("small", 10),
      id: "assistant-2",
    };
    const { client } = renderProbe();

    // The fresh primary lands and drives the polls + frozen snapshot.
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

    // A background refetch (window-focus / reconnect / incidental
    // invalidation) puts the onboarding query into isFetching WITHOUT
    // changing `open`. Because the primary already landed fresh
    // (dataUpdatedAt >= openedAt), it must stay selected — the polls and the
    // snapshot must not fall back to the active assistant.
    const gate = makeDeferred();
    onboardingGate = gate;
    await act(async () => {
      void client.invalidateQueries({
        queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      });
      // Let the held refetch enter its isFetching window.
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(latest!.assistantId).toBe("assistant-2");
    expect(latest!.actualsSnapshot).toEqual({
      machineSize: "small",
      storageGib: 10,
    });

    // The refetch completes: still the primary, snapshot unchanged.
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(latest!.assistantId).toBe("assistant-2"));
    expect(latest!.actualsSnapshot).toEqual({
      machineSize: "small",
      storageGib: 10,
    });
  }, 20_000);

  test("reopen with a stale cached onboarding primary tracks the fresh assistant, not the stale one", async () => {
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
    await waitFor(() => expect(latest!.assistantId).toBe("assistant-active"), {
      timeout: 5000,
    });
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
  }, 20_000);

  test("re-asks the reconcile when a downgrade's rollout was never observed", async () => {
    // The polls can miss a rollout entirely: it finishes between them, or they
    // error while the pod restarts. A downgrade meets its targets from the
    // first render, so with no marker watched there is nothing left that can
    // complete it, and the wait would run to the stall clock on a change that
    // already succeeded. The server checks marker and targets together, so
    // asking it again is the only terminal answer available.
    const client = makeClient();
    subscriptionPlanId = "pro";
    ensureResponse = makeEnsureResponse("in_progress");
    operationalStatusResponse = makeOperationalStatus("active");
    assistantResponse = makeAssistant("large", 50);
    renderProbe(client, true, 50);

    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
    const callsBefore = ensureCalls;

    // The rollout has since finished server-side; nobody here ever saw it.
    ensureResponse = makeEnsureResponse("already_done");

    await waitFor(() => expect(ensureCalls).toBeGreaterThan(callsBefore), {
      timeout: 5000,
    });
    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });
  }, 20_000);

  test("a marker cached before this open is not evidence for this change", async () => {
    // The lifecycle poller shares this query key, so the cache can already hold
    // a marker from an earlier resize on this same assistant. Adopting it would
    // let a finished resize vouch for one that has not started.
    const client = makeClient();
    client.setQueryData(
      STATUS_QUERY_KEY,
      makeResizeOperationStatus("resize_machine"),
      { updatedAt: realDateNow() - 60_000 },
    );
    subscriptionPlanId = "pro";
    // Every fresh read reports no operation at all, so the only marker that
    // ever existed is the cached one.
    operationalStatusResponse = makeOperationalStatus("active");
    assistantResponse = makeAssistant("large", 50);
    renderProbe(client, true);

    await waitFor(() => expect(latest!.assistantId).toBe("assistant-1"), {
      timeout: 5000,
    });
    await refetchAll(client);
    await refetchAll(client);

    expect(latest!.state).not.toBe("DONE");
    expect(latest!.state).not.toBe("NOT_APPLICABLE");
  }, 20_000);

  test("readings taken while closed do not qualify the next open", async () => {
    // The cache subscription outlives the takeover and the lifecycle poller
    // keeps this query warm, so readings can keep landing after a close. If
    // those counted, the next open would treat a cached marker as watched.
    const client = makeClient();
    subscriptionPlanId = "pro";
    operationalStatusResponse = makeOperationalStatus("active");
    assistantResponse = makeAssistant("large", 50);
    const { setOpen } = renderProbe(client, true);

    await waitFor(() => expect(latest!.assistantId).toBe("assistant-1"), {
      timeout: 5000,
    });
    await refetchAll(client);
    await act(async () => setOpen(false));

    // The takeover's own query is disabled while closed, but the lifecycle
    // poller holds the same key and keeps reading. Model that other consumer
    // directly: it catches a resize belonging to something else entirely and
    // leaves the marker in the shared cache.
    await act(async () => {
      await client.fetchQuery({
        queryKey: STATUS_QUERY_KEY,
        queryFn: () => makeResizeOperationStatus("resize_machine"),
      });
    });

    await act(async () => setOpen(true));
    await waitFor(() => expect(latest!.assistantId).toBe("assistant-1"), {
      timeout: 5000,
    });

    // The reopened takeover has watched nothing yet, so the cached marker is
    // not its evidence and it cannot complete off a later healthy reading.
    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    expect(latest!.state).not.toBe("DONE");
    expect(latest!.state).not.toBe("NOT_APPLICABLE");
  }, 20_000);

  test("a marker watched on the fallback assistant is not evidence for the primary", async () => {
    // Under a change that can lower the ceilings, a watched marker is the only
    // evidence the completion gate accepts, so an unkeyed latch would let the
    // fallback assistant's unrelated resize complete the primary's downsize.
    const client = makeClient();
    // Hold the on-open refetch so the stale cached primary (A) is tracked
    // first, then re-keys to the fresh one (B).
    const gate = makeDeferred();
    onboardingGate = gate;
    client.setQueryData(
      organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      { ...makeOnboarding(), primary_assistant_id: "assistant-A" },
      { updatedAt: realDateNow() - 60_000 },
    );
    subscriptionPlanId = "pro";
    onboardingResponse = {
      ...makeOnboarding(),
      primary_assistant_id: "assistant-B",
    };
    // The fence holds the stale primary off, so the active assistant is the
    // tracked fallback. It is mid-resize; the primary B sits at the targets with
    // no marker of its own, which is what a pre-marker downgrade looks like.
    operationalStatusResponse = makeOperationalStatus("resizing_machine");
    assistantResponse = {
      ...makeAssistant("large", 50),
      id: "assistant-active",
    };
    assistantsById["assistant-A"] = {
      ...makeAssistant("large", 50),
      id: "assistant-A",
    };
    assistantsById["assistant-B"] = {
      ...makeAssistant("large", 50),
      id: "assistant-B",
    };
    renderProbe(client, true);

    // Latch the marker while the fallback is the tracked assistant.
    await waitFor(() => expect(latest!.assistantId).toBe("assistant-active"), {
      timeout: 5000,
    });
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });

    // Re-key to the primary, whose own status carries no operation at all.
    operationalStatusResponse = makeOperationalStatus("active");
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(latest!.assistantId).toBe("assistant-B"), {
      timeout: 5000,
    });
    await refetchAll(client);

    // The fallback's marker belongs to another assistant, so it cannot stand in
    // as the primary's rollout evidence and the wait holds.
    expect(latest!.state).not.toBe("DONE");
    expect(latest!.state).not.toBe("NOT_APPLICABLE");
  }, 20_000);

  test("assistantId changing mid-open re-captures the snapshot against the new assistant", async () => {
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
  }, 20_000);

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

  test("a failed on-open refetch with only stale cached targets sets targetsError", async () => {
    const client = makeClient();
    // Onboarding cached from an earlier wizard session — never fetched during
    // this open, so routing (which gates on freshness) can't trust it.
    client.setQueryData(
      organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      makeOnboarding(),
      { updatedAt: realDateNow() - 60_000 },
    );
    subscriptionPlanId = "pro";
    onboardingFails = true;
    renderProbe(client);

    // Routing can never settle on the stale payload, so the failure has to
    // surface — otherwise the takeover stalls showing nothing.
    await waitFor(() => expect(latest!.targetsError).toBe(true), {
      timeout: 5000,
    });
    expect(latest!.onboardingSettled).toBe(false);
  });
});

describe("useProProvisioning — ensure-provisioned reconcile", () => {
  test("is not called before the subscription reports pro", async () => {
    renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    // Let several confirm polls land on the non-pro plan.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subscriptionCalls).toBeGreaterThan(0);
    expect(ensureCalls).toBe(0);
  });

  test("fires exactly once on the pro transition, across re-renders and repolls", async () => {
    ensureResponse = makeEnsureResponse("started");
    const { client, rerender } = renderProbe();
    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    expect(ensureCalls).toBe(0);

    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(ensureCalls).toBe(1), { timeout: 5000 });

    // Re-renders, further polls and the still-running clock must not re-fire
    // the reconcile — it is once per wizard open.
    rerender();
    await refetchAll(client);
    rerender();
    await refetchAll(client);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(ensureCalls).toBe(1);
  }, 20_000);

  test("a started verdict drives RESIZING with no operation ever observed", async () => {
    ensureResponse = makeEnsureResponse("started");
    subscriptionPlanId = "pro";
    renderProbe();

    // The operational status never reports a resize; the verdict alone is
    // enough to leave WAITING.
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
  });

  test("an already_done verdict finishes the wizard while the actuals still lag", async () => {
    ensureResponse = makeEnsureResponse("already_done");
    subscriptionPlanId = "pro";
    renderProbe();

    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });
  });

  test("a not_applicable / no_targets verdict is adopted as terminal", async () => {
    ensureResponse = makeEnsureResponse("not_applicable", "no_targets");
    subscriptionPlanId = "pro";
    renderProbe();

    await waitFor(() => expect(latest!.state).toBe("NOT_APPLICABLE"), {
      timeout: 5000,
    });
  });

  test("a not_applicable / no_active_pro verdict is never adopted and is retried once", async () => {
    // The entitlement race: the subscription flipped to pro but the
    // reconcile can't see the active pro entitlement yet.
    ensureResponse = makeEnsureResponse("not_applicable", "no_active_pro");
    subscriptionPlanId = "pro";
    renderProbe();

    await waitFor(() => expect(ensureCalls).toBe(1), { timeout: 5000 });
    // Adopting it would strand the wizard in a terminal NOT_APPLICABLE with
    // an unprovisioned assistant; inference keeps running instead.
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });

    // Exactly one automatic re-ask, which the race has resolved by now.
    ensureResponse = makeEnsureResponse("started");
    await waitFor(() => expect(ensureCalls).toBe(2), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ensureCalls).toBe(2);
  }, 20_000);

  test("a dead-end no_active_pro on the automatic path sets kickError", async () => {
    // The auto reconcile hits no_active_pro and schedules its one race
    // retry; the retry (also auto) hits the same dead end. With the
    // once-per-open re-ask spent, the repeat dead end now surfaces kickError
    // regardless of source.
    ensureResponse = makeEnsureResponse("not_applicable", "no_active_pro");
    subscriptionPlanId = "pro";
    renderProbe();

    // Two automatic calls: the initial one and its single race retry.
    await waitFor(() => expect(ensureCalls).toBe(2), { timeout: 5000 });
    await waitFor(
      () => expect(latest!.kickError).toEqual({ error: "no_active_pro" }),
      { timeout: 5000 },
    );
    // The verdict is still never adopted — inference keeps the flow WAITING.
    expect(latest!.state).toBe("WAITING");
  }, 20_000);

  test("a not_applicable / no_provisionable_assistants verdict is never adopted and is retried once", async () => {
    // The org holds the entitlement but has no settled assistant to apply it
    // to, so the reconcile queued nothing — the same non-answer as the
    // entitlement race.
    ensureResponse = makeEnsureResponse(
      "not_applicable",
      "no_provisionable_assistants",
    );
    subscriptionPlanId = "pro";
    renderProbe();

    await waitFor(() => expect(ensureCalls).toBe(1), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });

    // The assistant settles by the single automatic re-ask.
    ensureResponse = makeEnsureResponse("started");
    await waitFor(() => expect(ensureCalls).toBe(2), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ensureCalls).toBe(2);
  }, 20_000);

  test("a dead-end no_provisionable_assistants surfaces its own reason in kickError", async () => {
    ensureResponse = makeEnsureResponse(
      "not_applicable",
      "no_provisionable_assistants",
    );
    subscriptionPlanId = "pro";
    renderProbe();

    await waitFor(() => expect(ensureCalls).toBe(2), { timeout: 5000 });
    await waitFor(
      () =>
        expect(latest!.kickError).toEqual({
          error: "no_provisionable_assistants",
        }),
      { timeout: 5000 },
    );
    expect(latest!.state).toBe("WAITING");
  }, 20_000);

  test("a 503 on the automatic call never blocks the flow but is captured in kickError", async () => {
    ensureError = { error: "provisioning_submission_failed" };
    subscriptionPlanId = "pro";
    const { client } = renderProbe();

    await waitFor(() => expect(ensureCalls).toBe(1), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });
    // The automatic call failing does not block: no new blocking state, no
    // auto-retry storm. It is not silent either — the failure is captured in
    // kickError so the takeover can surface the snag variant.
    await waitFor(() =>
      expect(latest!.kickError).toEqual({
        error: "provisioning_submission_failed",
      }),
    );
    expect(latest!.confirmError).toBe(false);
    expect(latest!.targetsError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ensureCalls).toBe(1);

    // The webhook-driven resize lands anyway and the flow completes on pure
    // client-side inference.
    assistantResponse = makeAssistant("large", 50);
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("DONE"), {
      timeout: 5000,
    });
  }, 20_000);

  test("a verdict landing after close is discarded and never drives the next open", async () => {
    ensureDeferred = true;
    subscriptionPlanId = "pro";
    const { setOpen } = renderProbe();

    await waitFor(() => expect(ensureCalls).toBe(1), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });

    act(() => setOpen(false));

    // The first open's reconcile answers a terminal verdict only after the
    // close reset; adopting it would park the reopened wizard in DONE with
    // an assistant that is still below its targets.
    await act(async () => {
      pendingEnsures[0]!.resolve(makeEnsureResponse("already_done"));
      await Promise.resolve();
    });

    act(() => setOpen(true));
    await waitFor(() => expect(ensureCalls).toBe(2), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });

    // Only the reopen's own reconcile moves it.
    await act(async () => {
      pendingEnsures[1]!.resolve(makeEnsureResponse("started"));
      await Promise.resolve();
    });
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
  }, 20_000);

  test("an error landing after close does not surface on the next open", async () => {
    ensureDeferred = true;
    subscriptionPlanId = "pro";
    const { setOpen } = renderProbe();

    await waitFor(() => expect(ensureCalls).toBe(1), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });

    // A reconcile captures its error; this one is fired while open but only
    // rejects after close, so generation-gating must still discard it.
    act(() => latest!.kickProvisioning());
    await waitFor(() => expect(ensureCalls).toBe(2), { timeout: 5000 });

    act(() => setOpen(false));
    await act(async () => {
      pendingEnsures[1]!.reject({ error: "provisioning_submission_failed" });
      await Promise.resolve();
    });

    act(() => setOpen(true));
    await waitFor(() => expect(ensureCalls).toBe(3), { timeout: 5000 });
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });
    expect(latest!.kickError).toBeNull();
  }, 20_000);
});

describe("useProProvisioning presentation signals", () => {
  test("machineFloor is null before onboarding lands and for a real tier", async () => {
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    expect(latest!.machineFloor).toBeNull();

    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });
    expect(latest!.targets).toEqual({ machineSize: "large", storageGib: 50 });
    expect(latest!.machineFloor).toBeNull();
  });

  test("machineFloor is small when the package carries no machine tier", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = { ...makeOnboarding(), max_machine_tier: null };
    renderProbe();

    await waitFor(() => expect(latest!.machineFloor).toBe("small"), {
      timeout: 5000,
    });
    // The floor is display only, so it never becomes a machine target.
    expect(latest!.targets).toEqual({ machineSize: null, storageGib: 50 });
  });

  test("landed flips per dimension as each target is met", async () => {
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("WAITING"), {
      timeout: 5000,
    });
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // The machine lands first while storage is still growing.
    assistantResponse = makeAssistant("large", 10);
    await refetchAll(client);
    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: true, storage: false });
    });

    assistantResponse = makeAssistant("large", 50);
    await refetchAll(client);
    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: true, storage: true });
    });
  }, 20_000);

  test("an in-flight machine resize holds machine pending while storage lands", async () => {
    const { client } = renderProbe();
    await reachResizing(client);

    // The platform persists both effective sizes at resize acceptance, so the
    // actuals meet the targets while the pod is still restarting. Only the
    // machine marker is in flight, so storage may land ahead of it.
    assistantResponse = makeAssistant("large", 50);
    await refetchAll(client);
    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: false, storage: true });
    });
    expect(latest!.state).toBe("RESIZING");

    operationalStatusResponse = makeOperationalStatus("active");
    await refetchAll(client);
    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: true, storage: true });
    });
  }, 20_000);

  test("an active resize_storage operation holds only the storage flag", async () => {
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeResizeOperationStatus("resize_storage");
    await refetchAll(client);

    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: true, storage: false });
    });
  }, 20_000);

  test("the machine floor holds machine pending until the assistant downsizes", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = { ...makeOnboarding(), max_machine_tier: null };
    // Still above the floor the package settles at: the displayed downsize has
    // not happened, and the null machine target cannot catch that on its own.
    assistantResponse = makeAssistant("medium", 50);
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.machineFloor).toBe("small"), {
      timeout: 5000,
    });
    // Storage landing proves readings are being taken since the actuals, so
    // the floor is the only thing still holding the machine flag.
    await waitForLanded(client, () => {
      expect(latest!.landed.storage).toBe(true);
    });
    expect(latest!.landed.machine).toBe(false);

    assistantResponse = makeAssistant("small", 50);
    await refetchAll(client);
    await waitForLanded(client, () => {
      expect(latest!.landed.machine).toBe(true);
    });
  }, 20_000);

  test("a lower machine target holds machine pending until the pod downsizes", async () => {
    subscriptionPlanId = "pro";
    // Ultra to Super: the package buys a medium machine while the pod is still
    // large, so the displayed change is a downsize. Grow-only target semantics
    // read that as met on arrival.
    onboardingResponse = { ...makeOnboarding(), max_machine_tier: "medium" };
    assistantResponse = makeAssistant("large", 50);
    const { client } = renderProbe();

    await waitFor(
      () =>
        expect(latest!.targets).toEqual({
          machineSize: "medium",
          storageGib: 50,
        }),
      { timeout: 5000 },
    );
    // Storage landing proves readings are being taken since the actuals, so the
    // outstanding downsize is the only thing still holding the machine flag.
    await waitForLanded(client, () => {
      expect(latest!.landed.storage).toBe(true);
    });
    expect(latest!.landed.machine).toBe(false);

    assistantResponse = makeAssistant("medium", 50);
    await refetchAll(client);
    await waitForLanded(client, () => {
      expect(latest!.landed.machine).toBe(true);
    });
  }, 20_000);

  test("the same machine target growing is still judged as growth", async () => {
    subscriptionPlanId = "pro";
    // Same target, opposite direction: the pod starts below it, so the flag
    // must keep the grow-only comparison rather than flip to a downsize one.
    onboardingResponse = { ...makeOnboarding(), max_machine_tier: "medium" };
    assistantResponse = makeAssistant("small", 50);
    const { client } = renderProbe();

    await waitForLanded(client, () => {
      expect(latest!.landed.storage).toBe(true);
    });
    expect(latest!.landed.machine).toBe(false);

    assistantResponse = makeAssistant("medium", 50);
    await refetchAll(client);
    await waitForLanded(client, () => {
      expect(latest!.landed.machine).toBe(true);
    });
  }, 20_000);

  test("a landed flag waits for a status reading taken after the actuals", async () => {
    // `started` queues the resize on a worker, so the status query can still be
    // holding its pre-resize reading when the assistant poll lands the
    // persisted target sizes.
    ensureResponse = makeEnsureResponse("started");
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });

    // Only the assistant query advances here, so nothing has read the world
    // since the sizes it reports and no flag may land off them.
    assistantResponse = makeAssistant("large", 50);
    act(() => {
      client.setQueryData(ASSISTANT_QUERY_KEY, assistantResponse);
    });
    expect(latest!.state).toBe("RESIZING");
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // The reading that settles the flow settles the flags with it.
    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: true, storage: true });
    });
    expect(latest!.state).toBe("DONE");
  }, 20_000);

  test("a status fetch already out when a dimension meets its target does not land it", async () => {
    // `started` queues the resize on a worker, so the status query can be out
    // with its pre-resize reading when the assistant poll lands the persisted
    // target sizes.
    ensureResponse = makeEnsureResponse("started");
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // A status fetch goes out carrying the pre-resize reading, and is still out
    // when the assistant poll reports the persisted target sizes.
    const gate = makeDeferred();
    operationalStatusGate = gate;
    act(() => {
      void client.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    });
    await waitFor(() =>
      expect(client.getQueryState(STATUS_QUERY_KEY)?.fetchStatus).toBe(
        "fetching",
      ),
    );

    assistantResponse = makeAssistant("large", 50);
    await commitCacheWrite(() => {
      client.setQueryData(ASSISTANT_QUERY_KEY, assistantResponse);
    });
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // The clock moves on before that fetch answers, so its result stores
    // strictly after the dimensions read met: it postdates them in wall-clock
    // terms, though it observed the world before them. It may not land
    // anything.
    dateNowOffsetMs += 50;
    operationalStatusGate = null;
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    // The terminal gate compares storage times without the fence and so takes
    // that reading, which is the asymmetry the flags are stricter than. Waiting
    // for it also proves the reading was fully absorbed before the flags are
    // asserted to have ignored it.
    await waitFor(() => expect(latest!.state).toBe("DONE"), { timeout: 5000 });
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // The first fetch that starts after them does land them.
    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: true, storage: true });
    });
  }, 20_000);

  test("a status refetch starting between the render and the effect does not land a dimension", async () => {
    // The window a render-time reading cannot see: the hook renders with the
    // status query idle, a refetch goes out, and only then does the latch
    // effect run. That request still read the world before the resize marker,
    // so it may not land anything however late its answer is stored.
    ensureResponse = makeEnsureResponse("started");
    const { client } = renderProbe();

    await waitFor(() => expect(latest!.state).toBe("CONFIRMING"));
    subscriptionPlanId = "pro";
    await refetchAll(client);
    await waitFor(() => expect(latest!.state).toBe("RESIZING"), {
      timeout: 5000,
    });
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // Settle the status poll first: the window under test is a request that
    // begins after the render, not one already running when it starts.
    await act(async () => {
      await client.refetchQueries({ queryKey: STATUS_QUERY_KEY });
    });
    expect(client.getQueryState(STATUS_QUERY_KEY)?.fetchStatus).toBe("idle");

    // Held open so the request is unambiguously still out when the latch
    // effect runs.
    const gate = makeDeferred();
    operationalStatusGate = gate;
    onLayoutCommit = () => {
      const assistant = client.getQueryData(ASSISTANT_QUERY_KEY) as
        Assistant | undefined;
      // Only the commit that first carries the target sizes: that is the
      // render whose passive effect takes the latch.
      if (assistant?.machine_size !== "large") {
        return;
      }
      onLayoutCommit = null;
      void client.refetchQueries({ queryKey: STATUS_QUERY_KEY });
    };

    assistantResponse = makeAssistant("large", 50);
    await commitCacheWrite(() => {
      client.setQueryData(ASSISTANT_QUERY_KEY, assistantResponse);
    });
    expect(client.getQueryState(STATUS_QUERY_KEY)?.fetchStatus).toBe(
      "fetching",
    );
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // It answers after the dimensions read met, which is what a fence built on
    // storage times would take.
    dateNowOffsetMs += 50;
    operationalStatusGate = null;
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() =>
      expect(client.getQueryState(STATUS_QUERY_KEY)?.fetchStatus).toBe("idle"),
    );
    expect(latest!.landed).toEqual({ machine: false, storage: false });

    // A reading that starts after the latch does land them.
    await waitForLanded(client, () => {
      expect(latest!.landed).toEqual({ machine: true, storage: true });
    });
  }, 20_000);
});
