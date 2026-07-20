/**
 * Interaction tests for the pro onboarding wizard modal.
 *
 * Strategy mirrors use-pro-provisioning.test.tsx: mock the generated SDK with
 * mutable responses, render inside a QueryClientProvider + MemoryRouter, and
 * drive the provisioning polls deterministically with
 * queryClient.invalidateQueries() instead of waiting out refetch intervals.
 * The confirm-poll timeout is shrunk via the "./utils" mock; stall detection
 * is driven by offsetting Date.now past the stall threshold.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  Assistant,
  OnboardingStateResponse,
  OperationalStatus,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import { readCheckoutIntent, saveCheckoutIntent } from "@/lib/billing/checkout-intent";

import * as proOnboardingUtils from "./utils";

/** Shrunk so the confirm-timeout test doesn't wait out the real 10s poll. */
const TEST_CONFIRM_TIMEOUT_MS = 800;

mock.module("./utils", () => ({
  ...proOnboardingUtils,
  PRO_POLL_TIMEOUT_MS: TEST_CONFIRM_TIMEOUT_MS,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({ fetchOrganizations: () => Promise.resolve() }),
  },
}));

const realDateNow = Date.now.bind(Date);
let dateNowOffsetMs = 0;
Date.now = () => realDateNow() + dateNowOffsetMs;

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

function makeOnboarding(
  overrides: Partial<OnboardingStateResponse> = {},
): OnboardingStateResponse {
  return {
    max_machine_tier: "large",
    selected_storage_tier: "md",
    selected_storage_gib: 50,
    pvc_ready: false,
    domain_setup_available: true,
    primary_assistant_id: "assistant-1",
    ...overrides,
  };
}

function makeAssistant(
  machineSize: Assistant["machine_size"],
  storageGib: number | null,
): Assistant {
  return {
    id: "assistant-1",
    name: "Casey",
    handle: "casey",
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

type Captured = { path?: unknown; body?: unknown };

let subscriptionPlanId: SubscriptionResponse["plan_id"] = "base";
let onboardingResponse = makeOnboarding();
let assistantResponse = makeAssistant("small", 10);
let operationalStatusResponse = makeOperationalStatus("active");
let onboardingFails = false;
/** When set, onboarding responses hold until this promise resolves. */
let onboardingHold: Promise<void> | null = null;
let resizeCall: Captured | null = null;
/** When set, the resize mutation rejects with this error body. */
let resizeError: unknown = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({
      data: makeSubscription(subscriptionPlanId),
      response: { ok: true },
    }),
  organizationsBillingSubscriptionOnboardingRetrieve: () => {
    if (onboardingFails) {
      return Promise.reject(new Error("500 Internal Server Error"));
    }
    const result = { data: onboardingResponse, response: { ok: true } };
    return onboardingHold
      ? onboardingHold.then(() => result)
      : Promise.resolve(result);
  },
  assistantsActiveRetrieve: () =>
    Promise.resolve({ data: assistantResponse, response: { ok: true } }),
  assistantsRetrieve: () =>
    Promise.resolve({ data: assistantResponse, response: { ok: true } }),
  assistantsOperationalStatusDetailRead: () =>
    Promise.resolve({
      data: operationalStatusResponse,
      response: { ok: true },
    }),
  assistantsResize: (opts: Captured) => {
    resizeCall = opts;
    if (resizeError != null) {
      return Promise.reject(resizeError);
    }
    return Promise.resolve({
      data: { machine_size: "large", provisioned_storage_gib: 50 },
      response: { ok: true },
    });
  },
  assistantsDomainsList: () =>
    Promise.resolve({ data: { results: [] }, response: { ok: true } }),
  organizationsBillingSubscriptionOnboardingDomainCreate: () =>
    Promise.resolve({ data: { status: "ok" }, response: { ok: true } }),
}));

const { BillingOnboardingModal } = await import("./billing-onboarding-modal");

const BACKGROUND_LINE = "We're finishing your machine upgrade in the background.";

/**
 * Fast celebration dwell. Long enough for waitFor (50ms polls) to reliably
 * observe the transient DONE / NOT_APPLICABLE copy before it auto-advances.
 */
const TEST_DWELL_MS = 250;

function renderModal() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = mock(() => {});
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <BillingOnboardingModal open onClose={onClose} dwellMs={TEST_DWELL_MS} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { client, onClose, ...view };
}

beforeEach(() => {
  subscriptionPlanId = "base";
  onboardingResponse = makeOnboarding();
  assistantResponse = makeAssistant("small", 10);
  operationalStatusResponse = makeOperationalStatus("active");
  onboardingFails = false;
  onboardingHold = null;
  resizeCall = null;
  resizeError = null;
  dateNowOffsetMs = 0;
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  Date.now = realDateNow;
});

describe("BillingOnboardingModal", () => {
  test("happy path: confirm → resize observed → done → auto-advance to domain", async () => {
    saveCheckoutIntent({ kind: "package", packageKey: "super" });
    const { client, getByText } = renderModal();

    await waitFor(() =>
      expect(
        getByText("Payment confirmed — setting up your upgrade…"),
      ).toBeTruthy(),
    );
    expect(getByText("Super package")).toBeTruthy();

    subscriptionPlanId = "pro";
    await client.invalidateQueries();
    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );

    operationalStatusResponse = makeOperationalStatus("resizing_machine");
    await client.invalidateQueries();
    await waitFor(
      () => expect(getByText("Resizing your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeOperationalStatus("active");
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("Your upgrade is ready")).toBeTruthy(), {
      timeout: 5000,
    });
    // The celebration dwell elapses and the wizard advances to the domain step.
    await waitFor(() => expect(getByText("Assistant email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("domain_setup_available false skips straight to complete and clears the intent stash", async () => {
    saveCheckoutIntent({ kind: "package", packageKey: "super" });
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ domain_setup_available: false });
    const { client, getByText, queryByText } = renderModal();

    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );
    // Wait for the pre-resize actuals to land (the "from" card) before
    // mutating: an invalidate that races the initial actuals fetch is
    // swallowed, leaving the update to the next 2s poll.
    await waitFor(() => expect(getByText("10 GiB")).toBeTruthy(), {
      timeout: 5000,
    });

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("You're all set")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant email")).toBeNull();
    expect(queryByText(BACKGROUND_LINE)).toBeNull();
    expect(readCheckoutIntent()).toBeNull();
  });

  test("storage-only package provisions without a machine card", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ max_machine_tier: null });
    const { client, getByText, queryByText } = renderModal();

    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );
    // The resource cards appear once the onboarding targets land.
    await waitFor(() => expect(getByText("Storage")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Machine")).toBeNull();
    // Wait for the pre-resize actuals to land (the "from" card) before
    // mutating: an invalidate that races the initial actuals fetch is
    // swallowed, leaving the update to the next 2s poll.
    await waitFor(() => expect(getByText("10 GiB")).toBeTruthy(), {
      timeout: 5000,
    });

    assistantResponse = makeAssistant("small", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("Assistant email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("not-applicable fast path celebrates and advances without a resize", async () => {
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    const { getByText } = renderModal();

    await waitFor(() => expect(getByText("Your plan is ready")).toBeTruthy(), {
      timeout: 5000,
    });
    await waitFor(() => expect(getByText("Assistant email")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(resizeCall).toBeNull();
  });

  test("stall surfaces Apply & Restart; a successful apply resumes resizing through DONE", async () => {
    subscriptionPlanId = "pro";
    const { client, getByText, getByTestId } = renderModal();

    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );

    // Jump the wall clock past the stall threshold; the hook's next clock
    // tick re-derives the state as STALLED.
    dateNowOffsetMs = 200_000;
    await waitFor(() => expect(getByText("One more step")).toBeTruthy(), {
      timeout: 5000,
    });

    fireEvent.click(getByTestId("provisioning-apply"));
    await waitFor(() => expect(resizeCall).not.toBeNull());
    expect(resizeCall!.path).toEqual({ id: "assistant-1" });
    expect(resizeCall!.body).toEqual({ machine_size: "large", storage_gib: 50 });

    // The successful apply resumes observation: back to the resizing UI…
    await waitFor(
      () => expect(getByText("Resizing your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    // …and the resize landing completes the normal DONE → advance flow.
    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(
      () => expect(getByText("Your upgrade is ready")).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(getByText("Assistant email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("onboarding fetch failure after confirm shows the fetch-error state", async () => {
    subscriptionPlanId = "pro";
    onboardingFails = true;
    const { getByText, getByTestId, onClose } = renderModal();

    await waitFor(
      () => expect(getByText("Couldn't reach billing")).toBeTruthy(),
      { timeout: 5000 },
    );

    fireEvent.click(getByTestId("onboarding-go-to-billing"));
    expect(onClose).toHaveBeenCalled();
  });

  test("confirm timeout shows the payment-safe copy and retry restarts polling", async () => {
    const { getByText, getByTestId } = renderModal();

    await waitFor(
      () =>
        expect(
          getByText(
            "Your payment went through safely — we're still confirming your upgrade with Stripe. This can take a minute.",
          ),
        ).toBeTruthy(),
      { timeout: TEST_CONFIRM_TIMEOUT_MS + 3000 },
    );

    subscriptionPlanId = "pro";
    fireEvent.click(getByTestId("onboarding-retry"));
    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );
  });

  test("domain submit stays disabled while the machine is resizing", async () => {
    subscriptionPlanId = "pro";
    const { client, getByText, getByTestId, getByLabelText } = renderModal();

    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );

    // The escape hatch is a late fallback: it appears only once the watch has
    // run past the escape window (and the onboarding fetch has settled).
    dateNowOffsetMs = 61_000;
    await waitFor(
      () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
      { timeout: 5000 },
    );
    fireEvent.click(getByTestId("provisioning-escape"));
    await waitFor(() => expect(getByText("Assistant email")).toBeTruthy());

    expect(
      getByText(
        "Your assistant is restarting — you can set the domain in a moment.",
      ),
    ).toBeTruthy();
    // Wait for the handle prefill: with an empty subdomain the submit would be
    // disabled regardless, masking a missing machine-busy guard.
    await waitFor(() =>
      expect((getByLabelText("Subdomain") as HTMLInputElement).value).toBe(
        "casey",
      ),
    );
    expect(
      (getByTestId("onboarding-domain-set") as HTMLButtonElement).disabled,
    ).toBe(true);

    // The still-mounted hook sees the resize land and lifts the guard.
    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(
      () =>
        expect(
          (getByTestId("onboarding-domain-set") as HTMLButtonElement).disabled,
        ).toBe(false),
      { timeout: 5000 },
    );
  });

  test(
    "escape advances to complete with the background-finishing line, which clears on DONE",
    async () => {
      subscriptionPlanId = "pro";
      onboardingResponse = makeOnboarding({ domain_setup_available: false });
      const { client, getByText, getByTestId, queryByText } = renderModal();

      await waitFor(
        () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
        { timeout: 5000 },
      );
      dateNowOffsetMs = 61_000;
      await waitFor(
        () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
        { timeout: 5000 },
      );
      fireEvent.click(getByTestId("provisioning-escape"));

      await waitFor(() => expect(getByText("You're all set")).toBeTruthy());
      expect(getByText(BACKGROUND_LINE)).toBeTruthy();

      assistantResponse = makeAssistant("large", 50);
      await client.invalidateQueries();
      await waitFor(() => expect(queryByText(BACKGROUND_LINE)).toBeNull(), {
        timeout: 5000,
      });
    },
    20_000,
  );

  test(
    "escape hatch stays hidden until the escape window elapses",
    async () => {
      subscriptionPlanId = "pro";
      const { getByText, getByTestId, queryByTestId } = renderModal();

      await waitFor(
        () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
        { timeout: 5000 },
      );
      // Give the routing latch time to settle: still no escape hatch, because
      // the watch hasn't run long enough.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(queryByTestId("provisioning-escape")).toBeNull();

      dateNowOffsetMs = 61_000;
      await waitFor(
        () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
        { timeout: 5000 },
      );
    },
    20_000,
  );

  test("escape hatch waits for fresh routing data even once time-eligible", async () => {
    let releaseOnboarding!: () => void;
    onboardingHold = new Promise((resolve) => {
      releaseOnboarding = resolve;
    });
    subscriptionPlanId = "pro";
    const { getByText, getByTestId, queryByTestId } = renderModal();

    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );
    dateNowOffsetMs = 61_000;
    // Time-eligible, but domain_setup_available could still be stale — the
    // hatch must wait for the onboarding fetch to settle.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(queryByTestId("provisioning-escape")).toBeNull();

    releaseOnboarding();
    await waitFor(
      () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
      { timeout: 5000 },
    );
  });

  test("a failed apply surfaces its error and a late-landing resize still recovers", async () => {
    subscriptionPlanId = "pro";
    resizeError = {
      detail: "Another assistant operation is already in progress.",
    };
    const { client, getByText, getByTestId } = renderModal();

    await waitFor(
      () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
      { timeout: 5000 },
    );
    dateNowOffsetMs = 200_000;
    await waitFor(() => expect(getByText("One more step")).toBeTruthy(), {
      timeout: 5000,
    });

    // The rejection renders as-is on the stalled screen.
    fireEvent.click(getByTestId("provisioning-apply"));
    await waitFor(() => expect(resizeCall).not.toBeNull());
    await waitFor(() =>
      expect(
        getByText("Another assistant operation is already in progress."),
      ).toBeTruthy(),
    );
    expect(getByText("One more step")).toBeTruthy();

    // If a server-side resize was in fact still running, its landing is
    // observed by the actuals polling and replaces the stalled UI.
    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(
      () => expect(getByText("Your upgrade is ready")).toBeTruthy(),
      { timeout: 5000 },
    );
  });

  test(
    "a stall after escaping to complete offers Apply & Restart there",
    async () => {
      subscriptionPlanId = "pro";
      onboardingResponse = makeOnboarding({ domain_setup_available: false });
      const { client, getByText, getByTestId, queryByText, queryByTestId } =
        renderModal();

      await waitFor(
        () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
        { timeout: 5000 },
      );
      dateNowOffsetMs = 61_000;
      await waitFor(
        () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
        { timeout: 5000 },
      );
      fireEvent.click(getByTestId("provisioning-escape"));
      await waitFor(() => expect(getByText("You're all set")).toBeTruthy());
      expect(getByText(BACKGROUND_LINE)).toBeTruthy();

      // The backgrounded resize stalls: the finishing line swaps for a warning
      // with a manual apply.
      dateNowOffsetMs = 200_000;
      await waitFor(
        () => expect(getByTestId("complete-stalled-apply")).toBeTruthy(),
        { timeout: 5000 },
      );
      expect(queryByText(BACKGROUND_LINE)).toBeNull();

      // Applying resumes observation — the finishing line returns…
      fireEvent.click(getByTestId("complete-stalled-apply"));
      await waitFor(() => expect(resizeCall).not.toBeNull());
      await waitFor(() => expect(getByText(BACKGROUND_LINE)).toBeTruthy(), {
        timeout: 5000,
      });

      // …and the resize landing clears it.
      assistantResponse = makeAssistant("large", 50);
      await client.invalidateQueries();
      await waitFor(() => expect(queryByText(BACKGROUND_LINE)).toBeNull(), {
        timeout: 5000,
      });
      expect(queryByTestId("complete-stalled-apply")).toBeNull();
    },
    20_000,
  );

  test(
    "a stall while the user is on the domain step offers the apply controls and keeps the submit locked",
    async () => {
      subscriptionPlanId = "pro";
      const {
        client,
        getByText,
        getByTestId,
        getByLabelText,
        queryByText,
        queryByTestId,
      } = renderModal();

      await waitFor(
        () => expect(getByText("Setting up your new resources…")).toBeTruthy(),
        { timeout: 5000 },
      );
      dateNowOffsetMs = 61_000;
      await waitFor(
        () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
        { timeout: 5000 },
      );
      fireEvent.click(getByTestId("provisioning-escape"));
      await waitFor(() => expect(getByText("Assistant email")).toBeTruthy());
      await waitFor(() =>
        expect((getByLabelText("Subdomain") as HTMLInputElement).value).toBe(
          "casey",
        ),
      );

      // The flow stalls while the user is on the domain step: the machine may
      // still be mid-restart, so the guardian-channel submit stays locked and
      // the neutral busy notice swaps for the stalled warning + manual apply.
      dateNowOffsetMs = 200_000;
      await waitFor(
        () => expect(getByTestId("domain-stalled-apply")).toBeTruthy(),
        { timeout: 5000 },
      );
      expect(
        queryByText(
          "Your assistant is restarting — you can set the domain in a moment.",
        ),
      ).toBeNull();
      expect(
        (getByTestId("onboarding-domain-set") as HTMLButtonElement).disabled,
      ).toBe(true);

      // Applying resumes observation: the stalled controls give way to the
      // neutral busy notice while the resize is re-observed…
      fireEvent.click(getByTestId("domain-stalled-apply"));
      await waitFor(() => expect(resizeCall).not.toBeNull());
      await waitFor(() =>
        expect(
          getByText(
            "Your assistant is restarting — you can set the domain in a moment.",
          ),
        ).toBeTruthy(),
      );
      expect(queryByTestId("domain-stalled-apply")).toBeNull();

      // …and the resize landing lifts the guard.
      assistantResponse = makeAssistant("large", 50);
      await client.invalidateQueries();
      await waitFor(
        () =>
          expect(
            (getByTestId("onboarding-domain-set") as HTMLButtonElement)
              .disabled,
          ).toBe(false),
        { timeout: 5000 },
      );
    },
    20_000,
  );
});
