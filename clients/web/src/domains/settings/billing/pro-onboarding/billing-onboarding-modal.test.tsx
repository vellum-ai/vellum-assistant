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

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import {
  assistantsDomainsListOptions,
  assistantsDomainsListSetQueryData,
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveSetQueryData,
} from "@/generated/api/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  Assistant,
  EnsureProvisionedResponse,
  OnboardingStateResponse,
  OperationalStatus,
  PaginatedAssistantDomainList,
  PlanListResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import * as assistantAvatarMod from "@/hooks/use-assistant-avatar";
import {
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import * as toastMod from "@vellumai/design-library/components/toast";

import type { ResizeTakeoverContext } from "./billing-onboarding-modal";
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
  useRequestOrganizationId: () => null,
}));

// Stub the takeover avatar hook so the provisioning target's avatar doesn't
// fire (404-ing) fetches that each invalidateQueries() would await, slowing
// the polls past the test budget. The payload is mutable so the surface tint
// derived from it can be driven per-test.
let avatarComponents: CharacterComponents | null = null;
let avatarTraits: CharacterTraits | null = null;
let avatarCustomImageUrl: string | null = null;
mock.module("@/hooks/use-assistant-avatar", () => ({
  ...assistantAvatarMod,
  useAssistantAvatar: () => ({
    components: avatarComponents,
    traits: avatarTraits,
    customImageUrl: avatarCustomImageUrl,
    isLoading: false,
    invalidate: () => {},
  }),
}));

// Capture the escape toast so the exit-on-escape path can assert its message;
// keep the real module's other methods intact.
const toastInfoCalls: string[] = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastMod,
  toast: {
    ...toastMod.toast,
    info: (message: string) => {
      toastInfoCalls.push(message);
    },
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
    current_period_start: null,
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

/** A credit tier the chip can price from the catalog rather than its key. */
function creditTier(usd: number) {
  return {
    tier: `credits_${usd}`,
    label: `$${usd} credits/mo`,
    credits_usd: usd,
    price_cents: usd * 100,
    lookup_key: `credits_${usd}_key`,
    legacy: false,
  };
}

/** A pro catalog holding every credit tier the chip assertions move between. */
function plansWithCredits(): PlanListResponse {
  return {
    plans: [
      {
        id: "pro",
        name: "Pro",
        base_lookup_key: "pro_base",
        base_price_cents: 2000,
        billing_interval: "month",
        included_features: [],
        machine_tiers: [],
        storage_tiers: [],
        credit_tiers: [creditTier(25), creditTier(45), creditTier(50)],
        packages: [],
      },
    ],
  };
}

function makeDomains(hasDomain: boolean): PaginatedAssistantDomainList {
  return {
    count: hasDomain ? 1 : 0,
    next: null,
    previous: null,
    results: hasDomain
      ? [
          {
            id: "domain-1",
            subdomain: "velly",
            created: "2026-07-01T00:00:00Z",
            modified: "2026-07-01T00:00:00Z",
          },
        ]
      : [],
  };
}

let subscriptionPlanId: SubscriptionResponse["plan_id"] = "base";
let onboardingResponse = makeOnboarding();
let assistantResponse = makeAssistant("small", 10);
let operationalStatusResponse = makeOperationalStatus("active");
let onboardingFails = false;
/** When set, onboarding responses hold until this promise resolves. */
let onboardingHold: Promise<void> | null = null;
let ensureCalls = 0;
/** Verdict the reconcile endpoint answers with; "started" is the norm. */
let ensureResponse = makeEnsureResponse("started");
/** When set, the reconcile rejects with this error body (e.g. the 503). */
let ensureError: unknown = null;
/** When set, reconcile responses hold until this promise resolves. */
let ensureHold: Promise<void> | null = null;
/** Domains list the modal-level resize query reads; empty by default. */
let domainsResponse: PaginatedAssistantDomainList = makeDomains(false);
/** Counts modal-level domains fetches so tests can assert it never fires. */
let domainsCalls = 0;
/** When set, the domains list rejects (models the endpoint failing). */
let domainsFails = false;
/** When set, domains responses hold until this promise resolves. */
let domainsHold: Promise<void> | null = null;
/** When set, the active-assistant lookup rejects (an org with no fleet). */
let activeAssistantFails = false;
/** Counts domain-attach submissions so tests can assert none is ever made. */
let domainCreateCalls = 0;

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
  assistantsActiveRetrieve: () => {
    if (activeAssistantFails) {
      return Promise.reject(new Error("404 Not Found"));
    }
    return Promise.resolve({ data: assistantResponse, response: { ok: true } });
  },
  assistantsRetrieve: () =>
    Promise.resolve({ data: assistantResponse, response: { ok: true } }),
  assistantsOperationalStatusDetailRead: () =>
    Promise.resolve({
      data: operationalStatusResponse,
      response: { ok: true },
    }),
  organizationsBillingSubscriptionOnboardingEnsureProvisionedCreate: () => {
    ensureCalls += 1;
    if (ensureError != null) {
      return Promise.reject(ensureError);
    }
    const result = { data: ensureResponse, response: { ok: true } };
    return ensureHold ? ensureHold.then(() => result) : Promise.resolve(result);
  },
  assistantsDomainsList: () => {
    domainsCalls += 1;
    if (domainsFails) {
      return Promise.reject(new Error("500 Internal Server Error"));
    }
    const result = { data: domainsResponse, response: { ok: true } };
    return domainsHold
      ? domainsHold.then(() => result)
      : Promise.resolve(result);
  },
  organizationsBillingSubscriptionOnboardingDomainCreate: () => {
    domainCreateCalls += 1;
    return Promise.resolve({ data: { status: "ok" }, response: { ok: true } });
  },
}));

const { BillingOnboardingModal } = await import("./billing-onboarding-modal");
const { TAKEOVER_SURFACE, TAKEOVER_SURFACE_VAR } =
  await import("./provisioning-state");
const {
  clearTakeoverAvatarStash,
  readTakeoverAvatarStash,
  saveTakeoverAvatarStash,
} = await import("@/lib/billing/takeover-avatar-stash");

/**
 * Fast celebration dwell. Long enough for waitFor (50ms polls) to reliably
 * observe the transient DONE / NOT_APPLICABLE copy before it auto-advances.
 * These tests cover the flow, not the pacing, so the per-phase hold is off —
 * `use-held-phase.test.ts` and `provisioning-state.test.tsx` own that.
 */
const TEST_DWELL_MS = 250;

function renderModal({
  mode,
  resizeContext,
  plans,
}: {
  mode?: "checkout" | "resize";
  resizeContext?: ResizeTakeoverContext;
  plans?: PlanListResponse;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the plan catalog so the terminal credits chip resolves its label
  // without a fetch (the credits hook reads this shared query).
  if (plans) {
    client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  }
  const onClose = mock(() => {});
  const tree = (open: boolean) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <BillingOnboardingModal
          open={open}
          onClose={onClose}
          dwellMs={TEST_DWELL_MS}
          phaseMinMs={0}
          mode={mode}
          resizeContext={resizeContext}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const view = render(tree(true));
  /** Flips `open` to false, which is what the parent does on close. */
  const close = () => view.rerender(tree(false));
  return { client, onClose, close, ...view };
}

beforeEach(() => {
  avatarComponents = null;
  avatarTraits = null;
  avatarCustomImageUrl = null;
  subscriptionPlanId = "base";
  onboardingResponse = makeOnboarding();
  assistantResponse = makeAssistant("small", 10);
  operationalStatusResponse = makeOperationalStatus("active");
  onboardingFails = false;
  onboardingHold = null;
  ensureCalls = 0;
  ensureResponse = makeEnsureResponse("started");
  ensureError = null;
  ensureHold = null;
  domainsResponse = makeDomains(false);
  domainsCalls = 0;
  domainsFails = false;
  domainsHold = null;
  activeAssistantFails = false;
  domainCreateCalls = 0;
  dateNowOffsetMs = 0;
  toastInfoCalls.length = 0;
  sessionStorage.clear();
  // Also resets the stash module's in-memory mirror, which sessionStorage.clear()
  // leaves in place (it is simply never served while storage is readable).
  clearTakeoverAvatarStash();
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
      expect(getByText("Confirming your upgrade…")).toBeTruthy(),
    );
    expect(getByText("Super package")).toBeTruthy();

    subscriptionPlanId = "pro";
    await client.invalidateQueries();
    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    operationalStatusResponse = makeOperationalStatus("resizing_machine");
    await client.invalidateQueries();
    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    assistantResponse = makeAssistant("large", 50);
    operationalStatusResponse = makeOperationalStatus("active");
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    // The celebration dwell elapses and the wizard advances to the domain step.
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("a stash still carrying the signup marker is not named as purchased", async () => {
    // Keep the plan at base so CONFIRMING persists and the chip row is
    // observable — the happy path above is the same screen with an unmarked
    // stash, which does name its package. The marker only survives on a stash
    // that never reached the Stripe hand-off, so nothing was bought and naming
    // the package here would report a purchase that never happened.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { getByText, queryByText } = renderModal();

    await waitFor(
      () => expect(getByText("Confirming your upgrade…")).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(queryByText("Super package")).toBeNull();
  });

  test("domain_setup_available false skips straight to complete, clearing the intent there and the avatar stash on close", async () => {
    saveCheckoutIntent({ kind: "package", packageKey: "super" });
    saveTakeoverAvatarStash({
      assistantId: "assistant-1",
      components: BUNDLED_COMPONENTS,
      traits: null,
    });
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ domain_setup_available: false });
    const { client, close, getByText, queryByText } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    // Wait for the pre-resize actuals to land (the "from" card) before
    // mutating: an invalidate that races the initial actuals fetch is
    // swallowed, leaving the update to the next 2s poll.
    await waitFor(() => expect(getByText("10 GB")).toBeTruthy(), {
      timeout: 5000,
    });

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant Email")).toBeNull();
    expect(readCheckoutIntent()).toBeNull();
    // The stash outlives the step flip: the exit sheet still paints from the
    // surface it feeds, so clearing here would slide that tint mid-fade.
    expect(readTakeoverAvatarStash()).not.toBeNull();
    // Checkout mode never fires the modal-level domains query.
    expect(domainsCalls).toBe(0);

    close();
    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("no assistant to attach a domain to skips straight to complete", async () => {
    saveCheckoutIntent({ kind: "package", packageKey: "super" });
    subscriptionPlanId = "pro";
    // An org whose fleet holds nothing the caller can attach a domain to: the
    // onboarding payload names no primary assistant and there is no active one
    // either. The platform answers the reconcile `not_applicable` — there is
    // nothing to provision — and the domain POST would 409, so the step must
    // never be offered.
    onboardingResponse = makeOnboarding({ primary_assistant_id: null });
    activeAssistantFails = true;
    ensureResponse = makeEnsureResponse("not_applicable");
    const { getByText, queryByText } = renderModal();

    await waitFor(() => expect(getByText("Your plan is ready")).toBeTruthy(), {
      timeout: 5000,
    });
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant Email")).toBeNull();
    expect(domainCreateCalls).toBe(0);
  }, 20_000);

  test("the complete step exposes a close button that dismisses", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ domain_setup_available: false });
    const { client, getByText, onClose } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(getByText("10 GB")).toBeTruthy(), {
      timeout: 5000,
    });
    // The takeover holds no close control on the way through.
    expect(document.body.querySelector('[aria-label="Close"]')).toBeNull();

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });

    const close = document.body.querySelector('[aria-label="Close"]');
    expect(close).not.toBeNull();
    fireEvent.click(close as Element);
    expect(onClose).toHaveBeenCalled();
  });

  test("storage-only package provisions without a machine card", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ max_machine_tier: null });
    const { client, getByText, queryByText } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
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
    await waitFor(() => expect(getByText("10 GB")).toBeTruthy(), {
      timeout: 5000,
    });

    assistantResponse = makeAssistant("small", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("a machine-less package renders the floor its pod is capped down to", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ max_machine_tier: null });
    // A pod above the ceiling: the server caps it down to small, so the
    // takeover owes that row even though the package names no machine tier.
    assistantResponse = makeAssistant("medium", 10);
    const { getByTestId } = renderModal();

    await waitFor(() => expect(getByTestId("chip-machine")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(getByTestId("chip-machine").textContent).toContain("Medium");
    expect(getByTestId("chip-machine").textContent).toContain("Small");
  });

  test("a dimension that lands checks off while the machine rollout keeps spinning", async () => {
    subscriptionPlanId = "pro";
    operationalStatusResponse = makeOperationalStatus("resizing_machine");
    const { client, getByText, getByTestId } = renderModal();

    await waitFor(() => expect(getByTestId("chip-storage")).toBeTruthy(), {
      timeout: 5000,
    });
    // Wait for the pre-resize actuals to land (the "from" side) before
    // mutating, so the snapshot doesn't move with them.
    await waitFor(() => expect(getByText("10 GB")).toBeTruthy(), {
      timeout: 5000,
    });

    // Storage reaches its target while the machine is still rolling out.
    assistantResponse = makeAssistant("small", 50);
    await client.invalidateQueries();

    await waitFor(
      () =>
        expect(
          within(getByTestId("chip-storage")).getByTestId("chip-check"),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(
      within(getByTestId("chip-machine")).getByTestId("chip-spinner"),
    ).toBeTruthy();
  });

  test("already-provisioned fast path reconciles, celebrates and advances", async () => {
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    // Nothing to do: the reconcile confirms it rather than queueing a resize.
    ensureResponse = makeEnsureResponse("already_done");
    const { getByText } = renderModal();

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(ensureCalls).toBe(1);
  });

  test("ensure-provisioned being unavailable still lets the fast path resolve by inference", async () => {
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    // The reconcile 503s: no verdict, no error surface — the actuals the
    // wizard polls already meet the targets, so it reads NOT_APPLICABLE.
    ensureError = { error: "provisioning_submission_failed" };
    const { getByText, queryByText } = renderModal();

    await waitFor(() => expect(getByText("Your plan is ready")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Couldn't reach billing")).toBeNull();
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("provisioning renders a full-bleed dark takeover; the domain step reverts to a standard card", async () => {
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    const { getByText } = renderModal();

    // Provisioning phase: full-bleed, dark-themed Modal.Content.
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    const takeover = document.body.querySelector('[data-slot="modal-content"]');
    expect(takeover?.getAttribute("data-theme")).toBe("dark");
    expect(takeover?.className).toContain("w-screen");
    // The takeover renders no persistent close button — exits live in the step.
    expect(document.body.querySelector('[aria-label="Close"]')).toBeNull();

    // Domain step: standard card — no dark theme, no full-bleed sizing.
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
    const card = document.body.querySelector('[data-slot="modal-content"]');
    expect(card?.getAttribute("data-theme")).toBeNull();
    expect(card?.className).not.toContain("w-screen");
  });

  test("the takeover and its exit sheet both paint from the modal's surface variable", async () => {
    // The sheet covers the takeover while the modal changes shape and theme
    // underneath it, so a second colour there would show as a cross-fade.
    avatarComponents = BUNDLED_COMPONENTS;
    avatarTraits = { bodyShape: "blob", eyeStyle: "curious", color: "purple" };
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    const { getByText, findByTestId } = renderModal();

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    const content = document.body.querySelector<HTMLElement>(
      '[data-slot="modal-content"]',
    );
    expect(
      content?.style.getPropertyValue(TAKEOVER_SURFACE_VAR).toLowerCase(),
    ).toBe("#29202e");
    const takeover = document.body.querySelector<HTMLElement>(
      ".provision-surface-settle",
    );
    expect(takeover?.style.backgroundColor).toBe(TAKEOVER_SURFACE);

    const sheet = await findByTestId("takeover-exit-sheet");
    expect(sheet.style.backgroundColor).toBe(TAKEOVER_SURFACE);
  });

  test("a custom-image takeover's exit sheet reproduces the blurred backdrop", async () => {
    // A custom-image takeover paints its colour in a blurred backdrop, not the
    // ground fill. The exit sheet must carry that same image, or the covering
    // fade cross-fades the image to flat neutral — the handoff it exists to
    // prevent.
    avatarComponents = BUNDLED_COMPONENTS;
    avatarCustomImageUrl = "blob:vellum/avatar-image";
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    const { getByText, findByTestId } = renderModal();

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });

    const sheet = await findByTestId("takeover-exit-sheet");
    const backdrop = sheet.querySelector<HTMLElement>(
      '[data-testid="takeover-backdrop"]',
    );
    expect(backdrop).not.toBeNull();
    expect(backdrop?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:vellum/avatar-image",
    );
    // The sheet's own fade drives the reveal here, so the backdrop must not
    // re-fade over it.
    expect(backdrop?.className).not.toContain("provision-avatar-reveal");
  });

  test("a terminal takeover stays dismissable via the backdrop when routing is still resolving", async () => {
    // DONE lands from the reconcile verdict while the onboarding refetch is
    // held open: routing never settles, so the celebration auto-advance can't
    // fire. The backdrop must still dismiss — otherwise the user is stranded.
    onboardingHold = new Promise(() => {});
    subscriptionPlanId = "pro";
    ensureResponse = makeEnsureResponse("already_done");
    const { getByText, onClose } = renderModal();

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    // The X stays hidden throughout — the exit is the backdrop, not a button.
    expect(document.body.querySelector('[aria-label="Close"]')).toBeNull();

    const overlay = document.body.querySelector('[data-slot="modal-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);
    expect(onClose).toHaveBeenCalled();
  }, 20_000);

  test("an active provisioning takeover stays locked against backdrop dismissal", async () => {
    subscriptionPlanId = "pro";
    const { getByText, onClose } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    const overlay = document.body.querySelector('[data-slot="modal-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("the stall shows the honest taking-longer copy — no Apply — and confirming the background exit kicks the reconcile, toasts, and closes", async () => {
    subscriptionPlanId = "pro";
    const { getByText, getByTestId, queryByText, queryByTestId, onClose } =
      renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    // The wizard reconciled once on the pro transition.
    await waitFor(() => expect(ensureCalls).toBe(1));

    // Jump the wall clock past the stall threshold; the hook's next clock
    // tick re-derives the state as STALLED.
    dateNowOffsetMs = 200_000;
    await waitFor(
      () =>
        expect(getByText("This is taking longer than expected")).toBeTruthy(),
      { timeout: 5000 },
    );
    // The stalled takeover renders no Apply & Restart control.
    expect(queryByTestId("provisioning-apply")).toBeNull();

    // "Continue in the background" opens the confirm; it warns chat is
    // unavailable and does not kick or close on its own.
    fireEvent.click(getByTestId("provisioning-escape"));
    expect(getByText("Continue in the background?")).toBeTruthy();
    expect(ensureCalls).toBe(1);
    expect(onClose).not.toHaveBeenCalled();

    // Confirming with "Continue" fires the idempotent reconcile as a
    // fire-and-forget kick, toasts, and closes — it never advances the wizard.
    fireEvent.click(getByText("Continue"));
    await waitFor(() => expect(ensureCalls).toBe(2));
    expect(onClose).toHaveBeenCalled();
    expect(toastInfoCalls).toContain(
      "Your upgrade continues in the background.",
    );
    // No advance to the email/All-set steps while the machine is busy.
    expect(queryByText("Assistant Email")).toBeNull();
    expect(queryByText("You're all set!")).toBeNull();
  }, 20_000);

  test("waiting on the background confirm keeps the user on the takeover — no kick, no close", async () => {
    subscriptionPlanId = "pro";
    const { getByText, getByTestId, queryByText, onClose } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(ensureCalls).toBe(1));

    dateNowOffsetMs = 61_000;
    await waitFor(
      () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
      { timeout: 5000 },
    );

    // Open the confirm, then dismiss it with "Keep waiting".
    fireEvent.click(getByTestId("provisioning-escape"));
    expect(getByText("Continue in the background?")).toBeTruthy();
    fireEvent.click(getByText("Keep waiting"));

    // The dialog closes and nothing was kicked or closed — still upgrading.
    await waitFor(() =>
      expect(queryByText("Continue in the background?")).toBeNull(),
    );
    expect(ensureCalls).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
  }, 20_000);

  test("a resize settling while the background confirm is open dismisses it without force-closing the advanced step", async () => {
    subscriptionPlanId = "pro";
    // Route to complete so the dialog's own "Continue"/"Keep waiting" are the
    // only ones on screen — the domain step renders its own "Continue" button.
    onboardingResponse = makeOnboarding({ domain_setup_available: false });
    const { client, getByText, getByTestId, queryByText, onClose } =
      renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(ensureCalls).toBe(1));
    // Wait for the pre-resize actuals to land (the "from" card) before
    // mutating, mirroring the other DONE-transition tests.
    await waitFor(() => expect(getByText("10 GB")).toBeTruthy(), {
      timeout: 5000,
    });

    // Elapse the escape window so the background CTA surfaces while busy, then
    // open the confirm.
    dateNowOffsetMs = 61_000;
    await waitFor(
      () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
      { timeout: 5000 },
    );
    fireEvent.click(getByTestId("provisioning-escape"));
    expect(getByText("Continue in the background?")).toBeTruthy();

    // The resize finishes while the confirm is still open: actuals meet the
    // targets, so the machine settles and the wizard advances to complete.
    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });

    // The confirm auto-dismissed the moment provisioning stopped being busy,
    // so its "Continue" can't fire and force-close the wizard over the
    // now-uncovered complete step.
    expect(queryByText("Continue in the background?")).toBeNull();
    expect(
      queryByText(
        "Your assistant is still upgrading. Chatting won't be available until it finishes. You can keep waiting here, or continue and we'll let you know when it's ready.",
      ),
    ).toBeNull();
    expect(queryByText("Continue")).toBeNull();
    expect(queryByText("Keep waiting")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  }, 20_000);

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

  test("the fetch-error state renders as a standard card, not the full-bleed dark takeover", async () => {
    subscriptionPlanId = "pro";
    onboardingFails = true;
    const { getByText, getByTestId, onClose } = renderModal();

    await waitFor(
      () => expect(getByText("Couldn't reach billing")).toBeTruthy(),
      { timeout: 5000 },
    );

    // The error card must not inherit the provisioning takeover's full-bleed
    // dark treatment — it's a standard, legible, dismissible card.
    const content = document.body.querySelector('[data-slot="modal-content"]');
    expect(content?.getAttribute("data-theme")).toBeNull();
    expect(content?.className).not.toContain("w-screen");

    // The FetchErrorState UI and its go-to-billing action still render and act.
    expect(
      getByText(
        "We hit a problem checking your subscription. Your upgrade may still be processing. Return to billing to refresh.",
      ),
    ).toBeTruthy();
    fireEvent.click(getByTestId("onboarding-go-to-billing"));
    expect(onClose).toHaveBeenCalled();
  });

  test("confirm timeout shows the payment-safe copy and retry restarts polling", async () => {
    const { getByText, getByTestId } = renderModal();

    await waitFor(
      () =>
        expect(
          getByText(
            "Your payment went through safely. This can take a minute.",
          ),
        ).toBeTruthy(),
      { timeout: TEST_CONFIRM_TIMEOUT_MS + 3000 },
    );

    subscriptionPlanId = "pro";
    fireEvent.click(getByTestId("onboarding-retry"));
    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
  });

  test("confirming the background exit on a busy takeover kicks the reconcile, toasts, and closes — it never advances to complete", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ domain_setup_available: false });
    const { getByText, getByTestId, queryByText, onClose } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 15_000 },
    );
    // The wizard reconciled once on the pro transition.
    await waitFor(() => expect(ensureCalls).toBe(1));

    dateNowOffsetMs = 61_000;
    await waitFor(
      () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
      { timeout: 15_000 },
    );
    // The escape CTA opens the confirm; nothing kicks or closes until confirmed.
    fireEvent.click(getByTestId("provisioning-escape"));
    expect(getByText("Continue in the background?")).toBeTruthy();
    expect(ensureCalls).toBe(1);
    expect(onClose).not.toHaveBeenCalled();

    // Confirming with "Continue": a fire-and-forget kick, an error-free toast,
    // and a close — no advance to the All-set step, no background-finishing
    // line.
    fireEvent.click(getByText("Continue"));
    await waitFor(() => expect(ensureCalls).toBe(2));
    expect(onClose).toHaveBeenCalled();
    expect(toastInfoCalls).toContain(
      "Your upgrade continues in the background.",
    );
    expect(queryByText("You're all set!")).toBeNull();
  }, 30_000);

  test("escape hatch stays hidden until the escape window elapses", async () => {
    subscriptionPlanId = "pro";
    const { getByText, getByTestId, queryByTestId } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
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
  }, 20_000);

  test("escape hatch appears once time-eligible even while routing is unsettled", async () => {
    // The escape button is independent of routing — it's the always-available
    // recovery for a hung routing refetch. Hold the onboarding fetch open so
    // routing never settles; the hatch must still appear the moment the watch
    // passes the escape window.
    onboardingHold = new Promise(() => {});
    subscriptionPlanId = "pro";
    const { getByText, getByTestId } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    dateNowOffsetMs = 61_000;
    await waitFor(
      () => expect(getByTestId("provisioning-escape")).toBeTruthy(),
      { timeout: 5000 },
    );
  });

  test("a failed auto-reconcile shows the snag variant; escaping retries in the background and closes", async () => {
    subscriptionPlanId = "pro";
    // The automatic reconcile on the pro transition fails, so its error is
    // held as kickError — the ≥90s stall then shows the "snag" variant.
    ensureError = { error: "provisioning_submission_failed" };
    const { getByText, getByTestId, queryByTestId, onClose } = renderModal();

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(ensureCalls).toBe(1));

    dateNowOffsetMs = 200_000;
    await waitFor(
      () =>
        expect(
          getByText("We hit a snag upgrading your assistant"),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    // The mapped error is the caption; the snag takeover renders no Apply &
    // Restart control.
    expect(
      getByText(
        "We couldn't queue your upgrade just now. Try again in a moment.",
      ),
    ).toBeTruthy();
    expect(queryByTestId("provisioning-apply")).toBeNull();

    // The snag CTA reads "Retry in the background": clicking it opens the
    // confirm; confirming with "Continue" re-kicks the reconcile, toasts the
    // error-aware line, and closes.
    expect(getByText("Retry in the background")).toBeTruthy();
    fireEvent.click(getByTestId("provisioning-escape"));
    expect(getByText("Continue in the background?")).toBeTruthy();
    expect(ensureCalls).toBe(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByText("Continue"));
    await waitFor(() => expect(ensureCalls).toBe(2));
    expect(onClose).toHaveBeenCalled();
    expect(toastInfoCalls).toContain(
      "We'll retry your upgrade in the background.",
    );
  }, 20_000);

  test("an already-registered domain does not skip the domain step in checkout mode", async () => {
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    // A domain already exists, but checkout mode never consults it — the
    // modal-level query stays off and DomainStep renders its locked variant.
    domainsResponse = makeDomains(true);
    const { getByText } = renderModal();

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
  });
});

describe("BillingOnboardingModal — resize mode", () => {
  test("entitled with no domain routes through the domain step", async () => {
    subscriptionPlanId = "pro";
    const { client, getByText } = renderModal({ mode: "resize" });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("entitled with an existing domain skips straight to complete", async () => {
    subscriptionPlanId = "pro";
    domainsResponse = makeDomains(true);
    const { client, getByText, queryByText } = renderModal({ mode: "resize" });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant Email")).toBeNull();
  });

  test("fee-less package goes straight to complete and never queries domains", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({ domain_setup_available: false });
    const { client, getByText, queryByText } = renderModal({ mode: "resize" });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(getByText("10 GB")).toBeTruthy(), {
      timeout: 5000,
    });

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant Email")).toBeNull();
    // The fee-less gate keeps the modal-level domains query fully off.
    expect(domainsCalls).toBe(0);
  });

  test("no primary assistant skips the domain step even when an active one exists", async () => {
    subscriptionPlanId = "pro";
    // The payload names no primary assistant, but the active one resolves — a
    // self-hosted or teammate-owned assistant. The domain POST re-resolves the
    // primary server-side and ignores any client-held id, so routing on the
    // resolved `assistantId` would still walk into the 409.
    onboardingResponse = makeOnboarding({ primary_assistant_id: null });
    assistantResponse = makeAssistant("large", 50);
    ensureResponse = makeEnsureResponse("already_done");
    const { getByText, queryByText } = renderModal({ mode: "resize" });

    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant Email")).toBeNull();
    // With no domain step to offer, the modal-level domains query stays off.
    expect(domainsCalls).toBe(0);
    expect(domainCreateCalls).toBe(0);
  }, 20_000);

  test("a failing domains endpoint still advances to the domain step", async () => {
    subscriptionPlanId = "pro";
    domainsFails = true;
    const { client, getByText } = renderModal({ mode: "resize" });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    // An errored fetch counts as answered: routing falls back to the domain
    // step rather than hanging on the celebration.
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
  });

  test("a stale checkout intent is ignored in resize mode", async () => {
    // Keep the plan at base so CONFIRMING persists and the copy is observable.
    saveCheckoutIntent({ kind: "package", packageKey: "super" });
    const { getByText, queryByText } = renderModal({ mode: "resize" });

    await waitFor(
      () => expect(getByText("Confirming your upgrade…")).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(queryByText("Super package")).toBeNull();
  });

  test("carries a threaded credit change from the wait through to the terminal phase", async () => {
    subscriptionPlanId = "pro";
    const { client, getByTestId, getByText } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "small", storageGib: 10 },
        credits: { fromTier: "credits_25", toTier: "credits_50" },
        direction: "upgrade",
        canLowerResources: false,
      },
      plans: plansWithCredits(),
    });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    // One credits surface: the chip is on screen for the whole wait, not held
    // back for the terminal phase.
    expect(getByTestId("chip-credits").textContent).toContain("$25/mo");

    assistantResponse = makeAssistant("large", 50);
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("$25/mo");
    expect(chip.textContent).toContain("$50/mo");
  });

  test("resize mode draws its from-sides from the captured context, not live actuals", async () => {
    // The change lands before this mounts, so what the assistant reports can
    // already be the post-change machine. Only the captured snapshot still knows
    // where the change started, and it has to win.
    subscriptionPlanId = "pro";
    const { getByTestId, getByText } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "medium", storageGib: 30 },
        credits: null,
        direction: "upgrade",
        canLowerResources: false,
      },
    });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    // The live assistant reads Small / 10 GB; the captured snapshot is what the
    // chips state.
    await waitFor(
      () => expect(getByTestId("chip-machine").textContent).toContain("Medium"),
      { timeout: 5000 },
    );
    expect(getByTestId("chip-machine").textContent).not.toContain("Small");
    expect(getByTestId("chip-storage").textContent).toContain("30 GB");
  });

  test("a captured from-side with an unknown dimension falls back to the actuals", async () => {
    // The capture is per dimension: a machine read that had not settled when
    // the change was dispatched leaves that one null, and pinning the whole
    // from-side to the capture would freeze it null and drop the chip's
    // from-side for good.
    subscriptionPlanId = "pro";
    const { getByTestId, getByText } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: null, storageGib: 30 },
        credits: null,
        direction: "upgrade",
        canLowerResources: false,
      },
    });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    // Machine falls back to the actuals snapshot (Small); storage keeps the
    // captured 30 GB rather than the assistant's live 10 GB.
    await waitFor(
      () => expect(getByTestId("chip-machine").textContent).toContain("Small"),
      { timeout: 5000 },
    );
    expect(getByTestId("chip-storage").textContent).toContain("30 GB");
  });

  test("a resize mount with no captured context keeps the actuals snapshot", async () => {
    // The billing page's resize mount threads none, so its from-sides still come
    // from the pre-resize actuals.
    subscriptionPlanId = "pro";
    const { getByTestId, getByText, queryByTestId } = renderModal({
      mode: "resize",
    });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    // The from-side appears once the actuals snapshot latches.
    await waitFor(
      () => expect(getByTestId("chip-machine").textContent).toContain("Small"),
      { timeout: 5000 },
    );
    expect(queryByTestId("chip-credits")).toBeNull();
  });

  test("waits for a domains answer fresh for this open, not a stale cached one", async () => {
    // The reviewer's race: the shared assistantsDomainsList cache holds a
    // STALE empty result (the billing page's finish-setup notice populated it
    // just before this open) while the assistant in fact already has a domain.
    // Routing must ignore the stale cache and wait for the fresh refetch, then
    // skip to complete — never latch on the empty cache and route to the
    // domain step.
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    // Already at the target, so DONE lands off the reconcile without a resize.
    ensureResponse = makeEnsureResponse("already_done");
    // The fresh answer says a domain exists; held so routing can only observe
    // it once it lands — never the stale empty cache.
    domainsResponse = makeDomains(true);
    let releaseDomains!: () => void;
    domainsHold = new Promise((resolve) => {
      releaseDomains = resolve;
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed the stale empty list, timestamped before this open (negative
    // offset) yet still inside the 10s staleTime — so only the forced on-open
    // refetch, not a staleness-driven one, can produce a fresh answer.
    dateNowOffsetMs = -5000;
    assistantsDomainsListSetQueryData(
      client,
      { path: { assistant_id: "assistant-1" } },
      makeDomains(false),
    );
    dateNowOffsetMs = 0;

    const onClose = mock(() => {});
    const { getByText, queryByText } = render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <BillingOnboardingModal
            open
            onClose={onClose}
            dwellMs={TEST_DWELL_MS}
            phaseMinMs={0}
            mode="resize"
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Provisioning reaches DONE, but routing can't settle on the stale cache.
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    // The forced on-open refetch fired — a staleness check alone would not
    // have refetched the 5s-old cache.
    await waitFor(() => expect(domainsCalls).toBeGreaterThan(0));
    // While the fresh answer is still in flight, routing must not fall through
    // to the domain step off the stale empty cache.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(queryByText("Assistant Email")).toBeNull();
    expect(queryByText("You're all set!")).toBeNull();

    // The fresh answer lands: a domain already exists → skip to complete.
    releaseDomains();
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant Email")).toBeNull();
  }, 20_000);

  test("waits past a stale cached domains ERROR, not just a stale success", async () => {
    // The reviewer's P2 race: the shared assistantsDomainsList cache holds a
    // FAILED background refetch from before this open — React Query exposes
    // isError=true alongside the OLD (empty) list. That cached error must not
    // count as an answered domains read: routing has to wait for the forced
    // on-open refetch, which reveals an existing domain, then skip straight to
    // complete — never latch on the stale error and route to the domain step.
    subscriptionPlanId = "pro";
    assistantResponse = makeAssistant("large", 50);
    // Already at the target, so DONE lands off the reconcile without a resize.
    ensureResponse = makeEnsureResponse("already_done");

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const domainsQuery = assistantsDomainsListOptions({
      path: { assistant_id: "assistant-1" },
    });

    // Seed a stale errored cache timestamped before this open (negative
    // offset): an empty success, then a failed refetch on top. React Query
    // keeps the empty data with isError=true and an errorUpdatedAt earlier
    // than the open — the exact state the success-only fence let slip through.
    dateNowOffsetMs = -5000;
    domainsResponse = makeDomains(false);
    domainsFails = false;
    await client.fetchQuery({ ...domainsQuery, retry: false });
    domainsFails = true;
    await client
      .fetchQuery({ ...domainsQuery, retry: false, staleTime: 0 })
      .catch(() => {});
    dateNowOffsetMs = 0;

    // The forced on-open refetch reveals an existing domain; held so routing
    // can only observe it once it lands — never the stale cached error.
    domainsFails = false;
    domainsResponse = makeDomains(true);
    let releaseDomains!: () => void;
    domainsHold = new Promise((resolve) => {
      releaseDomains = resolve;
    });
    // Reset so `domainsCalls > 0` cleanly means the on-open refetch fired,
    // not the two seeding fetches above.
    domainsCalls = 0;

    const onClose = mock(() => {});
    const { getByText, queryByText } = render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <BillingOnboardingModal
            open
            onClose={onClose}
            dwellMs={TEST_DWELL_MS}
            phaseMinMs={0}
            mode="resize"
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Provisioning reaches DONE, but the cached error must not settle routing.
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    // The forced on-open refetch fired — the stale error alone is not answered.
    await waitFor(() => expect(domainsCalls).toBeGreaterThan(0));
    // While the fresh answer is still in flight, routing must not latch on the
    // stale error — neither the domain step nor complete may appear yet.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(queryByText("Assistant Email")).toBeNull();
    expect(queryByText("You're all set!")).toBeNull();

    // The fresh answer lands: a domain already exists → skip to complete.
    releaseDomains();
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByText("Assistant Email")).toBeNull();
  }, 20_000);

  test("re-invalidates domains when the provisioning target flips active→primary mid-open", async () => {
    // Multi-assistant race: the active assistant (A = "assistant-1") differs
    // from the onboarding payload's primary_assistant_id (B = "assistant-2").
    // A WARM stale onboarding cache (domain_setup_available: true) makes
    // domainAnswerNeeded flip true while provisioning.assistantId is still the
    // active A, so the on-open domains invalidation first fires for A. When
    // onboarding lands fresh, assistantId flips to B — whose domains list is
    // already cached within staleTime. The forced refetch must RE-FIRE for B
    // (a per-id guard), not latch on A (a boolean guard): otherwise B's cache
    // never crosses the open fence, domainsKnown stays false, routing never
    // settles, and the takeover strands on "All done!".
    subscriptionPlanId = "pro";
    // Active assistant A, already at the target so DONE lands off the verdict.
    assistantResponse = makeAssistant("large", 50);
    ensureResponse = makeEnsureResponse("already_done");
    // The fresh onboarding names primary B, distinct from active A.
    onboardingResponse = makeOnboarding({
      primary_assistant_id: "assistant-2",
    });

    // A 10s staleTime (matching the app's QueryClient) is essential: with the
    // default staleTime 0, re-keying to B's seeded cache would trigger a
    // staleness-driven refetch on mount and mask the bug. Here only the forced
    // on-open invalidation — the code under test — can refetch B's fresh cache.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
    });

    // Seed a WARM stale onboarding payload (domain_setup_available true),
    // timestamped before this open: it drives domainAnswerNeeded true during
    // the A window while onboardingFresh is still false. Held below so that
    // stale window persists and the invalidation latches on A first.
    dateNowOffsetMs = -5000;
    organizationsBillingSubscriptionOnboardingRetrieveSetQueryData(
      client,
      undefined,
      makeOnboarding({ primary_assistant_id: "assistant-2" }),
    );
    // Seed B's domains list empty, before this open yet inside the 10s
    // staleTime, so only the forced on-open refetch — never a staleness-driven
    // one — can cross the fence for B.
    assistantsDomainsListSetQueryData(
      client,
      { path: { assistant_id: "assistant-2" } },
      makeDomains(false),
    );
    dateNowOffsetMs = 0;

    // Hold the onboarding refetch so the A window (assistantId = active A,
    // domainAnswerNeeded true) is observable and the invalidation latches on A
    // before the primary B ever appears.
    let releaseOnboarding!: () => void;
    onboardingHold = new Promise((resolve) => {
      releaseOnboarding = resolve;
    });

    const onClose = mock(() => {});
    const { getByText } = render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <BillingOnboardingModal
            open
            onClose={onClose}
            dwellMs={TEST_DWELL_MS}
            phaseMinMs={0}
            mode="resize"
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // A window: DONE lands off the already_done verdict, but with onboarding
    // held routing can't settle yet — the takeover sits on "All done!".
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    // The forced on-open refetch fired for the active assistant A.
    await waitFor(() => expect(domainsCalls).toBeGreaterThan(0));
    const callsAfterActive = domainsCalls;

    // Release onboarding → assistantId flips to the primary B.
    releaseOnboarding();

    // The per-id guard re-invalidates for B, so its cached list is refetched
    // and crosses the fence; domainsKnown flips true, routing settles, and the
    // takeover auto-advances to the domain step (B has no domain) instead of
    // stranding on "All done!".
    await waitFor(() => expect(getByText("Assistant Email")).toBeTruthy(), {
      timeout: 5000,
    });
    // The re-fire for B is what unblocks routing — a boolean latch would have
    // skipped it and left B's fresh cache never crossing the fence.
    expect(domainsCalls).toBeGreaterThan(callsAfterActive);
  }, 20_000);
});

describe("BillingOnboardingModal (in-place custom change)", () => {
  /**
   * A per-dimension edit always reads "change", whichever way its dimensions
   * move, so the copy direction says nothing about whether a ceiling can drop.
   * These two run identical fixtures and differ only in that answer.
   */
  function creditOnlyFixtures() {
    subscriptionPlanId = "pro";
    // The pod already sits at the targets: a credit edit buys no machine and no
    // disk, so there is nothing for it to converge on.
    onboardingResponse = makeOnboarding({
      max_machine_tier: "medium",
      selected_storage_gib: 10,
      domain_setup_available: false,
    });
    assistantResponse = makeAssistant("medium", 10);
    operationalStatusResponse = makeOperationalStatus("active");
  }

  test("a credit-only change settles without waiting on a server verdict", async () => {
    creditOnlyFixtures();
    // The reconcile is held for the whole test, so no verdict can ever land.
    // Nothing but the client's own reading of the targets can resolve this.
    let releaseEnsure = () => {};
    ensureHold = new Promise<void>((resolve) => {
      releaseEnsure = () => resolve();
    });
    const { getByText, queryByText } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "medium", storageGib: 10 },
        credits: { fromTier: "credits_25", toTier: "credits_45" },
        direction: "change",
        canLowerResources: false,
      },
      plans: plansWithCredits(),
    });

    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(getByText("Your plan changes are live.")).toBeTruthy();
    // It resolved rather than riding the stall clock out to a snag.
    expect(queryByText("Updating your assistant…")).toBeNull();
    expect(queryByText("We hit a snag updating your assistant")).toBeNull();
    releaseEnsure();
  }, 20_000);

  test("the same change with a droppable ceiling still holds the wait", async () => {
    creditOnlyFixtures();
    let releaseEnsure = () => {};
    ensureHold = new Promise<void>((resolve) => {
      releaseEnsure = () => resolve();
    });
    const { client, getByText, queryByText } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "medium", storageGib: 10 },
        credits: { fromTier: "credits_25", toTier: "credits_45" },
        direction: "change",
        canLowerResources: true,
      },
      plans: plansWithCredits(),
    });

    await waitFor(() => expect(ensureCalls).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await client.invalidateQueries();
    await client.invalidateQueries();

    await waitFor(
      () => expect(getByText("Updating your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(queryByText("Your plan is ready")).toBeNull();
    expect(queryByText("You're all set!")).toBeNull();
    releaseEnsure();
  }, 20_000);
});

describe("BillingOnboardingModal (package downgrade)", () => {
  test("holds the wait while nothing has yet observed the restart", async () => {
    // The race a downgrade has to survive. Mighty names no machine tier and the
    // volume keeps its size, so the targets read met from the first render;
    // meanwhile the status query has not seen the restart and the reconcile has
    // not answered. Nothing has observed the pod going down, so nothing may say
    // it is back up: completing here would unlock chat against a gateway that
    // is still coming up.
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({
      max_machine_tier: null,
      selected_storage_gib: 10,
      domain_setup_available: false,
    });
    assistantResponse = makeAssistant("medium", 10);
    operationalStatusResponse = makeOperationalStatus("active");
    let releaseEnsure = () => {};
    ensureHold = new Promise<void>((resolve) => {
      releaseEnsure = () => resolve();
    });
    const { client, getByText, queryByText } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "medium", storageGib: 10 },
        credits: { fromTier: "credits_45", toTier: "credits_25" },
        direction: "downgrade",
        canLowerResources: true,
      },
      plans: plansWithCredits(),
    });

    // The reconcile has been asked and is still out.
    await waitFor(() => expect(ensureCalls).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await client.invalidateQueries();
    await client.invalidateQueries();

    await waitFor(
      () => expect(getByText("Updating your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(queryByText("Your plan is ready")).toBeNull();
    expect(queryByText("You're all set!")).toBeNull();

    // The restart surfaces, so there is finally something to observe.
    operationalStatusResponse = makeOperationalStatus("resizing_machine");
    await client.invalidateQueries();
    await waitFor(
      () => expect(getByText("Updating your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    await client.invalidateQueries();

    // The cap lands and the marker retires, which resolves the flow properly:
    // DONE, not the "nothing to do" terminal.
    assistantResponse = makeAssistant("small", 10);
    operationalStatusResponse = makeOperationalStatus("active");
    await client.invalidateQueries();
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    releaseEnsure();
  }, 20_000);

  test("Super → Mighty states the credit drop, the machine cap and no storage row", async () => {
    subscriptionPlanId = "pro";
    // Mighty names no machine tier, so the pod is capped down to the floor and
    // its storage stays exactly where it is.
    onboardingResponse = makeOnboarding({
      max_machine_tier: null,
      selected_storage_gib: 10,
      domain_setup_available: false,
    });
    assistantResponse = makeAssistant("medium", 10);
    operationalStatusResponse = makeOperationalStatus("resizing_machine");
    const { client, getByTestId, getByText, queryByTestId } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "medium", storageGib: 10 },
        credits: { fromTier: "credits_45", toTier: "credits_25" },
        direction: "downgrade",
        canLowerResources: true,
      },
      plans: plansWithCredits(),
    });

    // Nothing here calls the change an upgrade.
    await waitFor(
      () => expect(getByText("Updating your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );

    // Credits apply the moment the change is accepted, so that chip is already
    // checked while the machine is still rolling out.
    await waitFor(() => expect(getByTestId("chip-credits")).toBeTruthy(), {
      timeout: 5000,
    });
    const credits = getByTestId("chip-credits");
    expect(credits.textContent).toContain("$45/mo");
    expect(credits.textContent).toContain("$25/mo");
    expect(within(credits).getByTestId("chip-check")).toBeTruthy();

    const machine = getByTestId("chip-machine");
    expect(machine.textContent).toContain("Medium");
    expect(machine.textContent).toContain("Small");
    expect(within(machine).getByTestId("chip-spinner")).toBeTruthy();
    // The volume keeps its size, so there is no storage move to state.
    expect(queryByTestId("chip-storage")).toBeNull();

    // The cap lands and the resize marker retires.
    assistantResponse = makeAssistant("small", 10);
    operationalStatusResponse = makeOperationalStatus("active");
    await client.invalidateQueries();

    await waitFor(
      () =>
        expect(
          within(getByTestId("chip-machine")).getByTestId("chip-check"),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(getByText("You're all set!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(getByText("Your plan changes are live.")).toBeTruthy();
  }, 20_000);

  test("a pod already below the new ceiling gets no machine row at all", async () => {
    // Divergent state: the sub was billed a Medium ceiling while the pod had
    // long since settled at Small. Switching to Mighty drops the ceiling to the
    // floor the pod is already at, so the server's cap skips it and no resize
    // marker is ever created. A machine row here would arrive pre-checked and
    // assert a downsize that never ran.
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({
      max_machine_tier: null,
      selected_storage_gib: 10,
      domain_setup_available: false,
    });
    assistantResponse = makeAssistant("small", 10);
    ensureResponse = makeEnsureResponse("already_done");
    const { getByTestId, getByText, queryByTestId } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "small", storageGib: 10 },
        credits: { fromTier: "credits_45", toTier: "credits_25" },
        direction: "downgrade",
        canLowerResources: true,
      },
      plans: plansWithCredits(),
    });

    // Nothing is outstanding, so the flow resolves rather than hanging on a
    // dimension that never moves.
    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(queryByTestId("chip-machine")).toBeNull();
    expect(getByTestId("chip-credits").textContent).toContain("$25/mo");
  }, 20_000);

  test("Mighty → Super shows all three chips, storage pending until the grow lands", async () => {
    subscriptionPlanId = "pro";
    onboardingResponse = makeOnboarding({
      max_machine_tier: "medium",
      selected_storage_gib: 30,
      domain_setup_available: false,
    });
    assistantResponse = makeAssistant("small", 10);
    const { client, getByTestId, getByText } = renderModal({
      mode: "resize",
      resizeContext: {
        fromSnapshot: { machineSize: "small", storageGib: 10 },
        credits: { fromTier: "credits_25", toTier: "credits_45" },
        direction: "upgrade",
        canLowerResources: false,
      },
      plans: plansWithCredits(),
    });

    await waitFor(
      () => expect(getByText("Upgrading your assistant…")).toBeTruthy(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(getByTestId("chip-storage")).toBeTruthy(), {
      timeout: 5000,
    });

    const storage = getByTestId("chip-storage");
    expect(storage.textContent).toContain("10 GB");
    expect(storage.textContent).toContain("30 GB");
    expect(within(storage).getByTestId("chip-spinner")).toBeTruthy();
    const machine = getByTestId("chip-machine");
    expect(machine.textContent).toContain("Small");
    expect(machine.textContent).toContain("Medium");
    const credits = getByTestId("chip-credits");
    expect(credits.textContent).toContain("$25/mo");
    expect(credits.textContent).toContain("$45/mo");

    assistantResponse = makeAssistant("medium", 30);
    await client.invalidateQueries();

    await waitFor(
      () =>
        expect(
          within(getByTestId("chip-storage")).getByTestId("chip-check"),
        ).toBeTruthy(),
      { timeout: 5000 },
    );
  }, 20_000);
});
