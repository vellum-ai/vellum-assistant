/**
 * Unit tests for `awaitPurchasedProvisioning` — the post-payment provisioning
 * wait shared by the foreground hatching screen and the background hatch. The
 * invariants under test: a confirmed non-Pro read only completes early on a
 * NON-paid hatch, the reconcile nudge re-fires until it actually reconciles,
 * every exit routes through the post-resize healthz probe, and a healthz that
 * never recovers is a `health_timeout` failure rather than a completion.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GetAssistantResult, GetHealthzResult } from "@/assistant/api";

let localMode = false;
let getAssistantResult: GetAssistantResult = {
  ok: true,
  status: 200,
  data: {
    id: "ast-1",
    machine_size: "medium",
    provisioned_storage_gib: 50,
  } as never,
};
let healthzResult: GetHealthzResult = {
  ok: true,
  status: 200,
  data: {} as never,
};
let subscriptionReply: { data?: { plan_id?: string } } = {
  data: { plan_id: "pro" },
};
let onboardingReply: {
  data?: { max_machine_tier?: string; selected_storage_gib?: number };
} = { data: { max_machine_tier: "medium", selected_storage_gib: 50 } };
let opStatusReply: { data?: { state?: string } } = {
  data: { state: "running" },
};
let ensureProvisionedReply: { data?: { state?: string; reason?: string } } = {
  data: { state: "queued" },
};

const getAssistantMock = mock(
  async (_id?: string): Promise<GetAssistantResult> => getAssistantResult,
);
const getAssistantHealthzMock = mock(
  async (_id: string): Promise<GetHealthzResult> => healthzResult,
);
mock.module("@/assistant/api", () => ({
  getAssistant: getAssistantMock,
  getAssistantHealthz: getAssistantHealthzMock,
}));

const subscriptionRetrieveMock = mock(async () => subscriptionReply);
const onboardingRetrieveMock = mock(async () => onboardingReply);
const ensureProvisionedMock = mock(async () => ensureProvisionedReply);
const opStatusMock = mock(async () => opStatusReply);
mock.module("@/generated/api/sdk.gen", () => ({
  organizationsBillingSubscriptionRetrieve: subscriptionRetrieveMock,
  organizationsBillingSubscriptionOnboardingRetrieve: onboardingRetrieveMock,
  organizationsBillingSubscriptionOnboardingEnsureProvisionedCreate:
    ensureProvisionedMock,
  assistantsOperationalStatusDetailRead: opStatusMock,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => localMode,
}));

const { awaitPurchasedProvisioning, MAX_HATCH_WAIT_MS, POLL_INTERVAL_MS } =
  await import("./purchased-provisioning");

/** Poll a predicate without depending on the wait's own 3s poll interval. */
async function until(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    assistantId: "ast-1",
    postCheckoutReturn: false,
    managedHatch: true,
    hatchStartMs: Date.now(),
    isCancelled: () => false,
    ...overrides,
  };
}

beforeEach(() => {
  localMode = false;
  getAssistantResult = {
    ok: true,
    status: 200,
    data: {
      id: "ast-1",
      machine_size: "medium",
      provisioned_storage_gib: 50,
    } as never,
  };
  healthzResult = { ok: true, status: 200, data: {} as never };
  subscriptionReply = { data: { plan_id: "pro" } };
  onboardingReply = {
    data: { max_machine_tier: "medium", selected_storage_gib: 50 },
  };
  opStatusReply = { data: { state: "running" } };
  ensureProvisionedReply = { data: { state: "queued" } };
  getAssistantMock.mockClear();
  getAssistantHealthzMock.mockClear();
  subscriptionRetrieveMock.mockClear();
  onboardingRetrieveMock.mockClear();
  ensureProvisionedMock.mockClear();
  opStatusMock.mockClear();
});

describe("awaitPurchasedProvisioning", () => {
  test("a non-managed local hatch short-circuits with no network calls", async () => {
    localMode = true;

    const outcome = await awaitPurchasedProvisioning(
      baseOptions({ managedHatch: false }),
    );

    expect(outcome).toBe("ready");
    expect(ensureProvisionedMock).not.toHaveBeenCalled();
    expect(subscriptionRetrieveMock).not.toHaveBeenCalled();
    expect(getAssistantMock).not.toHaveBeenCalled();
    expect(getAssistantHealthzMock).not.toHaveBeenCalled();
  });

  test("confirmed non-Pro on a non-paid hatch completes with no resize hold", async () => {
    subscriptionReply = { data: { plan_id: "free" } };
    const onResizeWait = mock(() => {});

    const outcome = await awaitPurchasedProvisioning(
      baseOptions({ onResizeWait }),
    );

    expect(outcome).toBe("ready");
    expect(subscriptionRetrieveMock).toHaveBeenCalledTimes(1);
    expect(onResizeWait).not.toHaveBeenCalled();
    // No resize wait and no post-resize probe on a genuinely free hatch.
    expect(getAssistantMock).not.toHaveBeenCalled();
    expect(getAssistantHealthzMock).not.toHaveBeenCalled();
  });

  test("confirmed non-Pro on a post-checkout return keeps polling instead of completing", async () => {
    // Stripe redirects before the subscribe webhook lands, so the still-base
    // plan read is not an answer on a paid return.
    subscriptionReply = { data: { plan_id: "free" } };
    onboardingReply = {};
    let armed: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    void awaitPurchasedProvisioning(
      baseOptions({
        postCheckoutReturn: true,
        registerTimer: (timer: ReturnType<typeof setTimeout> | null) => {
          if (timer) {
            armed = timer;
          }
        },
      }),
    ).then(() => {
      settled = true;
    });

    await until(() => armed !== null);
    expect(settled).toBe(false);
    // Abandon the pending poll rather than burning the real 3s interval.
    clearTimeout(armed!);
  });

  test("Pro with targets holds for the resize, signals it once, then probes healthz", async () => {
    const onResizeWait = mock(() => {});

    const outcome = await awaitPurchasedProvisioning(
      baseOptions({ onResizeWait }),
    );

    expect(outcome).toBe("ready");
    expect(onResizeWait).toHaveBeenCalledTimes(1);
    expect(getAssistantMock).toHaveBeenCalledWith("ast-1");
    expect(opStatusMock).toHaveBeenCalledTimes(1);
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);
  });

  test("an unrecovered healthz after the resize is a health_timeout, not a completion", async () => {
    healthzResult = { ok: false, status: 503, error: {} as never };

    const outcome = await awaitPurchasedProvisioning(
      baseOptions({ hatchStartMs: Date.now() - MAX_HATCH_WAIT_MS - 1 }),
    );

    expect(outcome).toBe("health_timeout");
  });

  test("an entitlement-race reconcile reply re-fires the nudge; a reconciled one does not", async () => {
    ensureProvisionedReply = {
      data: { state: "not_applicable", reason: "no_active_pro" },
    };

    await awaitPurchasedProvisioning(baseOptions());

    // Entitlement loop + resize loop each nudge, because the race reply never
    // consumed the guard.
    expect(ensureProvisionedMock).toHaveBeenCalledTimes(2);

    ensureProvisionedMock.mockClear();
    ensureProvisionedReply = { data: { state: "queued" } };

    await awaitPurchasedProvisioning(baseOptions());

    expect(ensureProvisionedMock).toHaveBeenCalledTimes(1);
  });

  test("cancellation mid-wait resolves without further network calls", async () => {
    let cancelled = false;
    subscriptionRetrieveMock.mockImplementationOnce(async () => {
      cancelled = true;
      return subscriptionReply;
    });

    const outcome = await awaitPurchasedProvisioning(
      baseOptions({ isCancelled: () => cancelled }),
    );

    expect(outcome).toBe("ready");
    expect(onboardingRetrieveMock).not.toHaveBeenCalled();
    expect(getAssistantMock).not.toHaveBeenCalled();
    expect(getAssistantHealthzMock).not.toHaveBeenCalled();
  });

  test("a cancelled wait never sleeps out another poll interval", async () => {
    // Both reads reject, so the iteration reaches its sleep without passing a
    // cancellation check — the one path that could park a timer on a caller
    // that has already gone away.
    let cancelled = false;
    subscriptionRetrieveMock.mockImplementationOnce(async () => {
      cancelled = true;
      throw new Error("network");
    });
    onboardingRetrieveMock.mockImplementationOnce(async () => {
      throw new Error("network");
    });

    const startedAt = Date.now();
    const outcome = await awaitPurchasedProvisioning(
      baseOptions({ isCancelled: () => cancelled }),
    );

    expect(outcome).toBe("ready");
    expect(Date.now() - startedAt).toBeLessThan(POLL_INTERVAL_MS);
  });
});
