/**
 * Tests for the PlansPage takeover.
 *
 * Two harnesses share this file:
 *
 * 1. Static render (`renderStatic`) mirrors `plan-card.test.tsx`: it seeds the
 *    React Query cache so the page's `useQuery` calls resolve synchronously —
 *    `renderToStaticMarkup` is single-pass, so a pending query would report
 *    `isLoading` and render the spinner. Used for the catalog/label/price/
 *    current-plan/empty-catalog assertions. Avatars and the redirect both live
 *    in effects (not run by `renderToStaticMarkup`), so the pre-redirect markup
 *    is faithful.
 *
 * 2. Interaction (`renderInteractive`) mirrors `plans-page-checkout.test.tsx`:
 *    the generated SDK, browser runtime, platform gate, avatar compositor, and
 *    the provisioning-takeover modal are `mock.module()`'d, and `PlansPage` is
 *    dynamically imported after the mocks register. Used for the Pro
 *    change-package switch flow (confirm dialog → change-package → takeover)
 *    and the base-user Stripe checkout path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, useLocation } from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as platformGateMod from "@/hooks/use-platform-gate";
import * as platformDetection from "@/runtime/platform-detection";
import * as toastMod from "@vellumai/design-library/components/toast";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { routes } from "@/utils/routes";
import {
  clearTakeoverAvatarStash,
  readTakeoverAvatarStash,
} from "@/lib/billing/takeover-avatar-stash";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import { SWITCH_CAPTION } from "@/domains/settings/billing/plans/package-switch-copy";
import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import type {
  Assistant,
  MachineSizeEnum,
  OnboardingStateResponse,
  PackageChangeResponse,
  PlanListResponse,
  ProPlan,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

const CHECKOUT_URL = "https://stripe.test/checkout/session";
const PORTAL_URL = "https://stripe.test/portal/session";

type Captured = { body?: unknown };
let changePackageCall: Captured | null = null;
let upgradeCall: Captured | null = null;
// Captures the billing-portal session create, the cancel fallback for Pro
// subs the cancel endpoint rejects (non-entitlement statuses).
let portalSessionCall: Captured | null = null;
// Captures the subscription-cancel call, the Pro → Free cancel path.
let cancelSubscriptionCall: Captured | null = null;
// When false, the cancel promise never settles, which observes the in-flight
// (pending) state after confirming the Free downgrade.
let cancelSubscriptionResolves = true;
// When non-null the cancel call rejects with this, driving the error path
// (the hook toasts and resolves null, so the confirm dialog stays open).
let cancelSubscriptionError: unknown = null;
let machineTierCall: Captured | null = null;
let storageTierCall: Captured | null = null;
let creditTierCall: Captured | null = null;
let openedUrl: string | null = null;
let nativeAndroid = false;
// When non-null, the change-machine-tier call rejects — drives the failure path.
let machineTierError: unknown = null;
// Success/info-toast messages captured from the mocked toast module, so a path
// can assert exactly which confirmations fired without rendering the Toaster.
const toastSuccessCalls: string[] = [];
const toastInfoCalls: string[] = [];
// When false, the change-package promise never settles — used to observe the
// in-flight (pending) disabled state.
let changePackageAutoResolve = true;
// The data the mocked change-package resolves with; a test flips `status` to
// `no_op` to exercise the already-on-this-plan branch. Default is a clean switch.
let changePackageData: PackageChangeResponse = {
  status: "ok",
  package: { key: "mighty", name: "Mighty", version: 1, customized: false },
};
// When non-null the change-package call rejects with this — drives the error
// path (the hook toasts and resolves null, so the confirm dialog stays open).
let changePackageError: unknown = null;
// Fixtures returned by the mocked read SDK so post-mutation invalidation
// refetches resolve deterministically instead of hitting the network.
let subscriptionFixture: SubscriptionResponse | null = null;
let plansFixture: PlanListResponse | null = null;
let onboardingFixture: OnboardingStateResponse | null = null;
// When non-null the onboarding read waits on this before answering, which holds
// the query unsettled the way a cold load does.
let onboardingHold: Promise<void> | null = null;
// The assistant the machine from-side is read off, plus a log of how it was
// asked for, so the primary-then-active resolution can be asserted.
let assistantFixture: Assistant | null = null;
let activeAssistantFixture: Assistant | null = null;
const assistantByIdCalls: (string | null)[] = [];
let activeAssistantCalls = 0;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionChangePackageCreate: (opts: Captured) => {
    changePackageCall = opts;
    if (!changePackageAutoResolve) {
      return new Promise(() => {});
    }
    if (changePackageError !== null) {
      return Promise.reject(changePackageError);
    }
    return Promise.resolve({
      data: changePackageData,
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCall = opts;
    return Promise.resolve({
      data: { status: "redirect", checkout_url: CHECKOUT_URL },
      response: { ok: true },
    });
  },
  organizationsBillingPortalSessionCreate: (opts: Captured) => {
    portalSessionCall = opts;
    return Promise.resolve({
      data: { portal_url: PORTAL_URL },
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionCancelCreate: (opts: Captured) => {
    cancelSubscriptionCall = opts;
    if (!cancelSubscriptionResolves) {
      return new Promise(() => {});
    }
    if (cancelSubscriptionError !== null) {
      return Promise.reject(cancelSubscriptionError);
    }
    return Promise.resolve({
      data: { status: "ok", cancel_at: "2026-09-24T00:00:00Z" },
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionChangeMachineTierCreate: (opts: Captured) => {
    machineTierCall = opts;
    if (machineTierError !== null) {
      return Promise.reject(machineTierError);
    }
    return Promise.resolve({ data: {}, response: { ok: true } });
  },
  organizationsBillingSubscriptionChangeStorageTierCreate: (opts: Captured) => {
    storageTierCall = opts;
    return Promise.resolve({ data: {}, response: { ok: true } });
  },
  organizationsBillingSubscriptionChangeCreditTierCreate: (opts: Captured) => {
    creditTierCall = opts;
    return Promise.resolve({ data: {}, response: { ok: true } });
  },
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({ data: subscriptionFixture, response: { ok: true } }),
  organizationsBillingPlansRetrieve: () =>
    Promise.resolve({ data: plansFixture, response: { ok: true } }),
  organizationsBillingSubscriptionOnboardingRetrieve: () => {
    const result = { data: onboardingFixture, response: { ok: true } };
    return onboardingHold
      ? onboardingHold.then(() => result)
      : Promise.resolve(result);
  },
  assistantsRetrieve: (opts: { path?: { id?: string } }) => {
    assistantByIdCalls.push(opts.path?.id ?? null);
    return Promise.resolve({ data: assistantFixture, response: { ok: true } });
  },
  assistantsActiveRetrieve: () => {
    activeAssistantCalls += 1;
    return Promise.resolve({
      data: activeAssistantFixture,
      response: { ok: true },
    });
  },
}));

mock.module("@/runtime/browser", () => ({
  ...browserRuntime,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

// Force the platform-hosted gate open so the page mounts its pricing body
// instead of firing the self-hosted / not-ready redirect effect.
mock.module("@/hooks/use-platform-gate", () => ({
  ...platformGateMod,
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  useIsNativeAndroid: () => nativeAndroid,
}));

// Render avatar placeholders; skip the lazy compositor bundle in the DOM test.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

// Stand in for the provisioning takeover so the test can assert it was
// revealed in resize mode without driving its own provisioning polls.
// The full loading → "You're all set!" flow is owned by
// billing-onboarding-modal.test.tsx's resize-mode suite.
//
// Captures the context the page threads in, so the pre-change from-sides (and
// the switch path's omission of an unchanged bundle) can be asserted directly.
type CapturedResizeContext = {
  fromSnapshot: { machineSize: string | null; storageGib: number | null };
  credits: { fromTier: string | null; toTier: string | null } | null;
  direction: string;
  canLowerResources: boolean;
};
let takeoverResizeContext: CapturedResizeContext | undefined;
mock.module(
  "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal",
  () => ({
    BillingOnboardingModal: ({
      open,
      mode,
      resizeContext,
    }: {
      open: boolean;
      mode?: string;
      resizeContext?: CapturedResizeContext;
    }) => {
      if (open) {
        takeoverResizeContext = resizeContext;
      }
      return open ? (
        <div data-testid="resize-takeover" data-mode={mode ?? "checkout"} />
      ) : null;
    },
  }),
);

// Capture success/info toasts so the switch and downgrade paths can assert
// their confirmation messages; keep the real module's other methods (error,
// etc.) intact.
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastMod,
  toast: {
    ...toastMod.toast,
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    info: (message: string) => {
      toastInfoCalls.push(message);
    },
  },
}));

const { PlansPage } = await import("./plans-page");
const { getPlanTierCopy } = await import("./plans-copy");

// This page's assertions key off the storage/credit/price rows, so the three
// tiers come straight from the catalog fixtures rather than being re-specced
// here.
const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();
const ULTRA = makeUltraPackage();

function plansWith(packages: ProPackage[]): PlanListResponse {
  return {
    plans: [
      {
        id: "base",
        name: "Free",
        price_cents: 0,
        billing_interval: "month",
        included_features: [],
      },
      {
        id: "pro",
        name: "Pro",
        base_lookup_key: "pro_base",
        base_price_cents: 2000,
        billing_interval: "month",
        included_features: [],
        machine_tiers: [],
        storage_tiers: [],
        packages,
      },
    ],
  };
}

function fullCatalog(): PlanListResponse {
  return plansWith([MIGHTY, SUPER, ULTRA]);
}

function freeSubscription(): SubscriptionResponse {
  return {
    plan_id: "base",
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: "2026-07-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

function proMightySubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: "2026-07-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
  };
}

function proSuperSubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: "2026-07-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "super", name: "Super", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
  };
}

// ---------------------------------------------------------------------------
// Static-render harness
// ---------------------------------------------------------------------------

function renderStatic(
  subscription: SubscriptionResponse,
  plans: PlanListResponse,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  return renderToStaticMarkup(
    // MemoryRouter supplies the router context PlansPage's useNavigate needs.
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PlansPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function count(html: string, needle: RegExp): number {
  return (html.match(needle) ?? []).length;
}

describe("PlansPage — full catalog render", () => {
  test("renders the headline and all four tier names", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    expect(html).toContain("Give your assistant more power");
    expect(html).toContain("Base");
    expect(html).toContain("Mighty");
    expect(html).toContain("Super");
    expect(html).toContain("Ultra");
  });

  test("formats prices from the catalog totals (and 'Free' for the base tier)", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    // Anchored on the price element: "Free" also appears in CTA copy, so a bare
    // substring match would pass without the price label rendering at all.
    expect(html).toContain(">Free</span>");
    expect(html).not.toContain("$0/month");
    expect(html).toContain("$30/month");
    expect(html).toContain("$100/month");
    expect(html).toContain("$200/month");
  });

  test("shows the Recommended badge exactly once", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    // The badge text is "Recommended"; the all-caps look is CSS `uppercase`,
    // which renderToStaticMarkup does not apply.
    expect(count(html, /Recommended/g)).toBe(1);
    expect(html).not.toContain("Most Popular");
  });

  test("derives feature rows from the fixture (storage, credits, machine)", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    // Storage rows.
    expect(html).toContain("10 GB Storage");
    expect(html).toContain("30 GB Storage");
    expect(html).toContain("60 GB Storage");
    // Free plan's baseline storage (FREE_STORAGE_GIB).
    expect(html).toContain("4 GB Storage");
    // Credits row: the catalog's usage_label, matching the invoice line.
    expect(html).toContain("Mighty Usage included");
    // Machine "Computer" labels; a null machine_size renders "Small".
    expect(html).toContain("Small Computer");
    expect(html).toContain("Medium Computer");
    expect(html).toContain("Large Computer");
    // Copy-driven extra feature appended after the catalog rows.
    expect(html).toContain("Assistant email and subdomain");
  });

  test("uses the correct 'Includes:' label (not the Figma typo)", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    expect(html).toContain("Includes:");
    expect(html).not.toContain("Inlcudes:");
  });

  test("renders the per-tier CTA labels", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    expect(html).toContain("Power Up");
    expect(html).toContain("Go Super");
    expect(html).toContain("Unleash Ultra");
  });

  test("renders the custom-plan row and docs footer", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    expect(html).toContain("Custom Plan");
    expect(html).toContain("Configure");
    expect(html).toContain("Read our Docs.");
  });
});

describe("PlansPage — current-plan state", () => {
  test("free subscriber: Free is the current (disabled) plan, no Start Free", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    expect(html).toContain("Current Plan");
    // The Free card swaps its "Start Free" CTA for the current-plan label.
    expect(html).not.toContain("Start Free");
    // Exactly one column button is disabled — the current (Free) one. The
    // package CTAs stay enabled.
    expect(count(html, /disabled=""/g)).toBe(1);
  });

  test("pro subscriber on Mighty: Mighty is current, lower tiers downgrade, higher tiers upgrade", () => {
    const html = renderStatic(proMightySubscription(), fullCatalog());
    // Only the Mighty column is the current plan.
    expect(count(html, /Current Plan/g)).toBe(1);
    // Free sits below Mighty, so its CTA becomes a downgrade.
    expect(html).toContain("Downgrade to Base");
    expect(html).not.toContain("Start Free");
    // Super and Ultra sit above Mighty, so they keep their upgrade CTAs.
    expect(html).toContain("Go Super");
    expect(html).toContain("Unleash Ultra");
    // Two disabled buttons: the current-plan (Mighty) CTA, and Configure —
    // held disabled until the onboarding query supplies the current tiers,
    // which a static first-paint render (no effects) never loads.
    expect(count(html, /disabled=""/g)).toBe(2);
  });

  test("pro subscriber on Mighty: no Recommended badge, but Mighty keeps the light card", () => {
    const html = renderStatic(proMightySubscription(), fullCatalog());
    expect(html).not.toContain("Recommended");
    expect(count(html, /data-theme="light"/g)).toBe(1);
    expect(html).toContain("Current Plan");
  });

  test("pro subscriber on Super: Mighty is a downgrade, no Recommended badge, but keeps the light card", () => {
    const html = renderStatic(proSuperSubscription(), fullCatalog());
    // Mighty sits below Super, so its CTA is a downgrade and the chip is hidden.
    expect(html).toContain("Downgrade to Mighty");
    expect(html).not.toContain("Recommended");
    // Mighty still renders as the light card for a Super subscriber.
    expect(count(html, /data-theme="light"/g)).toBe(1);
  });
});

describe("PlansPage — empty catalog (pro-packages flag off)", () => {
  test("renders the loading fallback, not the pricing grid", () => {
    // The redirect fires in a useEffect (not run by renderToStaticMarkup), so
    // the pre-redirect markup is the loading spinner.
    const html = renderStatic(freeSubscription(), plansWith([]));
    expect(html).toContain("Loading plans");
    expect(html).not.toContain("Give your assistant more power");
    expect(html).not.toContain("Mighty");
    expect(html).not.toContain("Power Up");
    expect(html).not.toContain("Custom Plan");
  });
});

describe("getPlanTierCopy", () => {
  test("returns tier copy including the recommended flag and CTA", () => {
    expect(getPlanTierCopy("mighty")?.cta).toBe("Power Up");
    expect(getPlanTierCopy("mighty")?.recommended).toBe(true);
    expect(getPlanTierCopy("super")?.recommended).toBeFalsy();
    expect(getPlanTierCopy("ultra")?.cta).toBe("Unleash Ultra");
  });

  test("returns undefined for an unknown tier key", () => {
    expect(getPlanTierCopy("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Interaction harness — Pro change-package switch + base-user checkout
// ---------------------------------------------------------------------------

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

/**
 * An assistant whose pod sits at `machineSize` on a `provisionedStorageGib`
 * volume, the two resource from-sides the chips read.
 */
function makeAssistant(
  id: string,
  machineSize: MachineSizeEnum,
  provisionedStorageGib = 10,
): Assistant {
  return {
    id,
    name: "Casey",
    handle: "casey",
    machine_size: machineSize,
    provisioned_storage_gib: provisionedStorageGib,
  } as Assistant;
}

/** Onboarding state carrying a Pro sub's current machine/storage tiers. */
function onboarding(
  overrides: Partial<OnboardingStateResponse> = {},
): OnboardingStateResponse {
  return {
    max_machine_tier: "medium",
    selected_storage_tier: "xs",
    selected_storage_gib: 10,
    pvc_ready: true,
    domain_setup_available: false,
    primary_assistant_id: null,
    ...overrides,
  };
}

function renderInteractive(
  subscription: SubscriptionResponse,
  {
    plans = fullCatalog(),
    onboardingData = onboarding(),
    seedOnboarding = true,
  }: {
    plans?: PlanListResponse;
    /** Null models a read that settled with no payload, e.g. one that failed. */
    onboardingData?: OnboardingStateResponse | null;
    /** False leaves the onboarding query to fetch, so it mounts unsettled. */
    seedOnboarding?: boolean;
  } = {},
) {
  subscriptionFixture = subscription;
  plansFixture = plans;
  onboardingFixture = onboardingData;
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
      },
    },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  if (seedOnboarding) {
    client.setQueryData(
      organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      onboardingData,
    );
  }
  return {
    // Exposed so the checkout test can seed the avatar cache the stash reads.
    client,
    ...render(
      <MemoryRouter initialEntries={["/assistant/plans"]}>
        <QueryClientProvider client={client}>
          <PlansPage />
        </QueryClientProvider>
        <LocationProbe />
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  changePackageCall = null;
  upgradeCall = null;
  portalSessionCall = null;
  cancelSubscriptionCall = null;
  cancelSubscriptionResolves = true;
  cancelSubscriptionError = null;
  machineTierCall = null;
  storageTierCall = null;
  creditTierCall = null;
  openedUrl = null;
  nativeAndroid = false;
  machineTierError = null;
  changePackageAutoResolve = true;
  changePackageData = {
    status: "ok",
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
  };
  changePackageError = null;
  subscriptionFixture = null;
  plansFixture = null;
  onboardingFixture = null;
  onboardingHold = null;
  assistantFixture = makeAssistant("assistant-primary", "medium");
  activeAssistantFixture = makeAssistant("assistant-active", "large");
  assistantByIdCalls.length = 0;
  activeAssistantCalls = 0;
  toastSuccessCalls.length = 0;
  toastInfoCalls.length = 0;
  takeoverResizeContext = undefined;
  // The stash and the assistants store are module-level globals, so reset both.
  clearTakeoverAvatarStash();
  useResolvedAssistantsStore.setState({
    activeAssistantId: null,
    assistants: [],
    assistantsHydrated: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("PlansPage on native Android", () => {
  test("renders the takeover in place, same as iOS", async () => {
    nativeAndroid = true;
    const { findByRole, getByTestId } = renderInteractive(freeSubscription());

    expect(await findByRole("button", { name: "Power Up" })).toBeTruthy();
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
  });

  test("a plan CTA opens this page on the web app instead of checking out", async () => {
    nativeAndroid = true;
    const { findByRole } = renderInteractive(freeSubscription());

    fireEvent.click(await findByRole("button", { name: "Power Up" }));

    await waitFor(() =>
      expect(openedUrl).toBe(
        new URL(routes.plans, window.location.origin).toString(),
      ),
    );
    expect(upgradeCall).toBeNull();
    expect(changePackageCall).toBeNull();
  });

  test("Configure opens this page on the web app instead of the custom modal", async () => {
    nativeAndroid = true;
    const { findByRole, queryByRole } = renderInteractive(freeSubscription(), {
      plans: customCatalog(),
    });

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    await waitFor(() =>
      expect(openedUrl).toBe(
        new URL(routes.plans, window.location.origin).toString(),
      ),
    );
    expect(queryByRole("dialog")).toBeNull();
    expect(upgradeCall).toBeNull();
  });
});

describe("PlansPage — Pro package switch (change-package)", () => {
  test("Super → Mighty downgrade confirms, then calls change-package and opens the takeover", async () => {
    const { findByRole, findByTestId, getByTestId, queryByTestId } =
      renderInteractive(proSuperSubscription());

    // Click the Mighty column's downgrade CTA (below Super).
    fireEvent.click(
      await findByRole("button", { name: "Downgrade to Mighty" }),
    );

    // The reconfirm dialog appears; confirm it.
    fireEvent.click(await findByTestId("confirm-package-switch-button"));

    await waitFor(() => expect(changePackageCall).not.toBeNull());
    expect(changePackageCall!.body).toEqual({ package: "mighty" });

    // A downgrade caps the machine down and restarts the pod like any other
    // switch, so it watches the same takeover, with no fire-and-forget toast.
    await waitFor(() =>
      expect(queryByTestId("confirm-package-switch-button")).toBeNull(),
    );
    const takeover = await findByTestId("resize-takeover");
    expect(takeover.getAttribute("data-mode")).toBe("resize");
    expect(takeoverResizeContext?.direction).toBe("downgrade");
    // Mighty names no machine tier, so the pod is capped to the floor: met
    // targets can't stand in for "nothing was owed" here.
    expect(takeoverResizeContext?.canLowerResources).toBe(true);
    expect(toastSuccessCalls).toEqual([]);
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(upgradeCall).toBeNull();
  });

  test("an unread current tier is treated as able to lower, not as the floor", async () => {
    // A failed onboarding read settles `currentReady` while leaving every
    // dimension null, and a null machine tier is what a machine-less package
    // reports. Ranking that null would read a Super sub as sitting on the
    // floor and hand a real downgrade the inference only a raise earns.
    const { findByRole, findByTestId } = renderInteractive(
      proSuperSubscription(),
      { onboardingData: null },
    );

    fireEvent.click(
      await findByRole("button", { name: "Downgrade to Mighty" }),
    );
    fireEvent.click(await findByTestId("confirm-package-switch-button"));
    await findByTestId("resize-takeover");

    expect(takeoverResizeContext?.canLowerResources).toBe(true);
  });

  test("an untrusted tier read snapshots no pod at all", async () => {
    // Holding the assistant query is not enough: a disabled query still serves
    // whatever the cache holds, and a null primary makes the hook answer with
    // the ACTIVE assistant, which is the wrong pod in the org where this
    // matters. The captured from-sides have to be empty, not merely unfetched.
    activeAssistantFixture = makeAssistant("assistant-active", "large", 50);
    // Open the gate first so the active assistant lands in the cache, which is
    // the only way the stale path has anything to serve.
    const { findByRole, findByTestId, client } = renderInteractive(
      proSuperSubscription(),
      { onboardingData: onboarding({ primary_assistant_id: null }) },
    );
    await waitFor(() => expect(activeAssistantCalls).toBeGreaterThan(0));

    // Now close it: same payload, older read.
    act(() => {
      client.setQueryData(
        organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
        onboardingFixture,
        { updatedAt: Date.now() - 60_000 },
      );
    });

    fireEvent.click(
      await findByRole("button", { name: "Downgrade to Mighty" }),
    );
    fireEvent.click(await findByTestId("confirm-package-switch-button"));
    await findByTestId("resize-takeover");

    expect(takeoverResizeContext?.fromSnapshot).toEqual({
      machineSize: null,
      storageGib: null,
    });
  });

  test("Super → Ultra upgrade confirms, then calls change-package with the ultra key", async () => {
    const { findByRole, findByTestId, getByTestId } = renderInteractive(
      proSuperSubscription(),
    );

    // The Ultra column keeps its upgrade CTA copy ("Unleash Ultra").
    fireEvent.click(await findByRole("button", { name: "Unleash Ultra" }));
    fireEvent.click(await findByTestId("confirm-package-switch-button"));

    await waitFor(() => expect(changePackageCall).not.toBeNull());
    expect(changePackageCall!.body).toEqual({ package: "ultra" });

    const takeover = await findByTestId("resize-takeover");
    expect(takeover.getAttribute("data-mode")).toBe("resize");
    expect(takeoverResizeContext?.direction).toBe("upgrade");
    // Ultra raises the ceiling, so the fast no-op inference is kept.
    expect(takeoverResizeContext?.canLowerResources).toBe(false);
    // The sub holds no bundle and Ultra pins one, so the tier move is threaded.
    expect(takeoverResizeContext?.credits).toEqual({
      fromTier: null,
      toTier: "credits_115",
    });
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
  });

  test("a switch that leaves the bundle alone threads no credits chip", async () => {
    // Super pins credits_45 and the sub already holds it, so there is no move to
    // state and the chip is dropped.
    const { findByRole, findByTestId } = renderInteractive({
      ...proMightySubscription(),
      selected_credit_tier: "credits_45",
    });

    fireEvent.click(await findByRole("button", { name: "Go Super" }));
    fireEvent.click(await findByTestId("confirm-package-switch-button"));
    await findByTestId("resize-takeover");

    expect(takeoverResizeContext?.credits).toBeNull();
  });

  test("a package switch hands the takeover the pre-change machine, storage and bundle", async () => {
    // The server caps the machine before change-package answers, and the hook
    // then invalidates the subscription and onboarding reads, so every "current"
    // value the page can read once the await resolves is already post-change.
    // Model that by flipping each fixture to its post-change value before the
    // switch is confirmed: only a capture taken ahead of the await survives it.
    // The disk carries 25 GB while the billed tier reads 30, the spread a
    // volume keeps after its tier was lowered. The chip must state the disk.
    assistantFixture = makeAssistant("assistant-primary", "medium", 25);
    const { findByRole, findByTestId } = renderInteractive(
      { ...proSuperSubscription(), selected_credit_tier: "credits_45" },
      {
        onboardingData: onboarding({
          primary_assistant_id: "assistant-primary",
          selected_storage_gib: 30,
        }),
      },
    );
    // Let the by-id assistant read land before the pod grows.
    await waitFor(() => expect(assistantByIdCalls.length).toBeGreaterThan(0));

    changePackageData = {
      status: "ok",
      package: { key: "ultra", name: "Ultra", version: 1, customized: false },
    };
    subscriptionFixture = {
      ...proSuperSubscription(),
      selected_credit_tier: "credits_115",
    };
    onboardingFixture = onboarding({
      primary_assistant_id: "assistant-primary",
      max_machine_tier: "large",
      selected_storage_gib: 60,
    });
    assistantFixture = makeAssistant("assistant-primary", "large", 60);

    fireEvent.click(await findByRole("button", { name: "Unleash Ultra" }));
    fireEvent.click(await findByTestId("confirm-package-switch-button"));
    await findByTestId("resize-takeover");

    expect(takeoverResizeContext?.fromSnapshot).toEqual({
      machineSize: "medium",
      storageGib: 25,
    });
    expect(takeoverResizeContext?.credits).toEqual({
      fromTier: "credits_45",
      toTier: "credits_115",
    });
  });

  test("the machine from-side reads the onboarding payload's primary assistant", async () => {
    // The takeover watches the primary-then-active assistant, so the chip's
    // from-side has to describe that same pod. In a multi-assistant org the
    // active one is a different machine.
    const { findByRole, findByTestId } = renderInteractive(
      proSuperSubscription(),
      {
        onboardingData: onboarding({
          primary_assistant_id: "assistant-primary",
        }),
      },
    );

    fireEvent.click(await findByRole("button", { name: "Unleash Ultra" }));
    fireEvent.click(await findByTestId("confirm-package-switch-button"));
    await findByTestId("resize-takeover");

    expect(assistantByIdCalls).toContain("assistant-primary");
    expect(activeAssistantCalls).toBe(0);
    // "medium" is the primary's size; the active assistant reads "large".
    expect(takeoverResizeContext?.fromSnapshot.machineSize).toBe("medium");
  });

  test("an unsettled onboarding read never resolves the from-side to the active assistant", async () => {
    // On a cold load the onboarding payload has not answered, so no primary is
    // named yet. Reading through to the active assistant in that window returns
    // a real machine size for the wrong pod in a multi-assistant org, and the
    // capture then states it for the life of the takeover.
    let releaseOnboarding = () => {};
    onboardingHold = new Promise<void>((resolve) => {
      releaseOnboarding = resolve;
    });
    const { findByRole, findByTestId } = renderInteractive(
      proSuperSubscription(),
      { seedOnboarding: false },
    );

    const cta = await findByRole("button", { name: "Unleash Ultra" });
    expect(assistantByIdCalls).toEqual([]);
    expect(activeAssistantCalls).toBe(0);

    fireEvent.click(cta);
    fireEvent.click(await findByTestId("confirm-package-switch-button"));
    // Let the post-change invalidation refetches settle so the takeover opens.
    releaseOnboarding();
    await findByTestId("resize-takeover");

    // Unknown, not the active assistant's "large". Storage has the same window.
    expect(takeoverResizeContext?.fromSnapshot).toEqual({
      machineSize: null,
      storageGib: null,
    });
  });

  test("with no primary named the from-side falls back to the active assistant", async () => {
    const { findByRole, findByTestId } = renderInteractive(
      proSuperSubscription(),
      { onboardingData: onboarding({ primary_assistant_id: null }) },
    );

    fireEvent.click(await findByRole("button", { name: "Unleash Ultra" }));
    fireEvent.click(await findByTestId("confirm-package-switch-button"));
    await findByTestId("resize-takeover");

    expect(assistantByIdCalls).toEqual([]);
    expect(takeoverResizeContext?.fromSnapshot.machineSize).toBe("large");
  });

  test("Pro → Free downgrade confirms first, then cancels via the cancel endpoint", async () => {
    const { findByRole, findByText, findByTestId, getByTestId, queryByText } =
      renderInteractive(proSuperSubscription());

    // Below Super, Base reads "Downgrade to Base". Clicking it opens the confirm
    // dialog, not an immediate cancellation.
    fireEvent.click(await findByRole("button", { name: "Downgrade to Base" }));
    await findByText("Downgrade to Base?");
    expect(cancelSubscriptionCall).toBeNull();

    // Confirming posts the subscription-cancel endpoint (the same action as the
    // adjust-plan modal's Downgrade to Base) and closes the confirm.
    // Cancellation can't go through the package-only change-package endpoint.
    fireEvent.click(await findByTestId("confirm-free-downgrade-button"));
    await waitFor(() => expect(cancelSubscriptionCall).not.toBeNull());
    await waitFor(() => expect(queryByText("Downgrade to Base?")).toBeNull());
    // The confirmation toast names the scheduled end date.
    expect(
      toastInfoCalls.some((m) => m.startsWith("Pro plan canceled")),
    ).toBe(true);
    // Stays on the plans page with no Stripe redirect, and never touches the
    // portal/package/checkout endpoints.
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(openedUrl).toBeNull();
    expect(portalSessionCall).toBeNull();
    expect(changePackageCall).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("a non-entitlement Pro status falls back to the Stripe billing portal", async () => {
    // The cancel endpoint 403s a sub `is_pro_active` rejects, so an unpaid
    // Pro sub keeps the old portal handoff, where Stripe can still cancel it.
    const { findByRole, findByText, findByTestId } = renderInteractive({
      ...proSuperSubscription(),
      status: "unpaid",
    });

    fireEvent.click(await findByRole("button", { name: "Downgrade to Base" }));
    // The confirm's body copy states the handoff instead of promising an
    // in-app cancellation.
    await findByText("You'll be taken to Stripe to cancel your subscription.", {
      exact: false,
    });
    fireEvent.click(await findByTestId("confirm-free-downgrade-button"));

    await waitFor(() => expect(openedUrl).toBe(PORTAL_URL));
    expect(portalSessionCall).not.toBeNull();
    expect(cancelSubscriptionCall).toBeNull();
  });

  test("dismissing the Free downgrade confirm doesn't cancel the sub", async () => {
    const { findByRole, findByText, getByRole, queryByText } =
      renderInteractive(proSuperSubscription());

    fireEvent.click(await findByRole("button", { name: "Downgrade to Base" }));
    await findByText("Downgrade to Base?");

    // The confirm dialog's Cancel closes it without posting the cancellation.
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(queryByText("Downgrade to Base?")).toBeNull());
    expect(cancelSubscriptionCall).toBeNull();
    expect(openedUrl).toBeNull();
  });

  test("a failed cancellation keeps the confirm open for a retry", async () => {
    cancelSubscriptionError = { detail: "Cancellation failed." };
    const { findByRole, findByText, findByTestId } = renderInteractive(
      proSuperSubscription(),
    );

    fireEvent.click(await findByRole("button", { name: "Downgrade to Base" }));
    fireEvent.click(await findByTestId("confirm-free-downgrade-button"));
    await waitFor(() => expect(cancelSubscriptionCall).not.toBeNull());

    // The hook toasted the error and resolved null, so the dialog stays open
    // for a retry instead of closing on a cancellation that didn't happen.
    await findByText("Downgrade to Base?");
    expect(toastInfoCalls).toEqual([]);
  });

  test("the Free downgrade confirm lists the Pro features being lost", async () => {
    const plans = fullCatalog();
    const pro = plans.plans.find((p) => p.id === "pro") as ProPlan;
    // Base plan lists no features, so both Pro features are "lost".
    pro.included_features = ["Managed email", "Custom domain"];
    const { findByRole, findByText } = renderInteractive(
      proSuperSubscription(),
      { plans },
    );

    fireEvent.click(await findByRole("button", { name: "Downgrade to Base" }));
    await findByText("Downgrade to Base?");
    await findByText("Managed email");
    await findByText("Custom domain");
  });

  test("while the cancellation is in flight, the other plan CTAs and Configure are disabled", async () => {
    // Hold the cancel request in flight so the cancel mutation's pending state
    // stays true after the Free downgrade is confirmed.
    cancelSubscriptionResolves = false;
    const { findByRole, findByTestId } = renderInteractive(
      proMightySubscription(),
    );

    fireEvent.click(await findByRole("button", { name: "Downgrade to Base" }));
    const confirm = (await findByTestId(
      "confirm-free-downgrade-button",
    )) as HTMLButtonElement;
    fireEvent.click(confirm);

    // The cancel request is in flight and never settles: the confirm dialog
    // stays open with its actions disabled, and every background plan CTA is
    // disabled too (queried with hidden, because the open dialog marks the
    // page behind it aria-hidden), so a second click can't start a competing
    // billing operation before it resolves.
    const goSuper = (await findByRole("button", {
      name: "Go Super",
      hidden: true,
    })) as HTMLButtonElement;
    const configure = (await findByRole("button", {
      name: "Configure",
      hidden: true,
    })) as HTMLButtonElement;
    await waitFor(() => {
      expect(confirm.disabled).toBe(true);
      expect(goSuper.disabled).toBe(true);
      expect(configure.disabled).toBe(true);
    });

    // The cancellation was actually initiated, and no competing action started.
    expect(cancelSubscriptionCall).not.toBeNull();
    expect(changePackageCall).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("base user CTA starts Stripe checkout, not change-package", async () => {
    const { client, findByRole } = renderInteractive(freeSubscription());
    // Capture only stashes for a hydrated list holding exactly one assistant.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "a1",
      assistants: [
        { id: "a1", isLocal: false, isPlatformHosted: true, isPaired: false },
      ],
      assistantsHydrated: true,
    });
    client.setQueryData([...avatarQueryKey("a1"), true], {
      components: BUNDLED_COMPONENTS,
      traits: null,
      customImageUrl: null,
    });

    fireEvent.click(await findByRole("button", { name: "Go Super" }));

    await waitFor(() => expect(upgradeCall).not.toBeNull());
    expect(upgradeCall!.body).toMatchObject({
      target_plan_id: "pro",
      package: "super",
      confirm: true,
    });
    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(changePackageCall).toBeNull();
    // The redirect snapshots the avatar so the takeover can draw it on return.
    expect(readTakeoverAvatarStash()?.assistantId).toBe("a1");
  });

  test("the confirm CTA is disabled while a switch is pending", async () => {
    changePackageAutoResolve = false;
    const { findByRole, findByTestId } = renderInteractive(
      proSuperSubscription(),
    );

    fireEvent.click(
      await findByRole("button", { name: "Downgrade to Mighty" }),
    );
    const confirm = (await findByTestId(
      "confirm-package-switch-button",
    )) as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(changePackageCall).not.toBeNull();
  });

  test("a no_op result closes the dialog without opening the takeover", async () => {
    changePackageData = {
      status: "no_op",
      package: { key: "ultra", name: "Ultra", version: 1, customized: false },
    };
    const { findByRole, findByTestId, queryByTestId } = renderInteractive(
      proSuperSubscription(),
    );

    fireEvent.click(await findByRole("button", { name: "Unleash Ultra" }));
    fireEvent.click(await findByTestId("confirm-package-switch-button"));

    await waitFor(() => expect(changePackageCall).not.toBeNull());
    // no_op means the org is already on that package: the confirm dialog closes
    // but the provisioning takeover never opens.
    await waitFor(() =>
      expect(queryByTestId("confirm-package-switch-button")).toBeNull(),
    );
    expect(queryByTestId("resize-takeover")).toBeNull();
  });

  test("a failed switch keeps the confirm dialog open for retry", async () => {
    changePackageError = { detail: "Payment failed. Your card was declined." };
    const { findByRole, findByTestId, queryByTestId } = renderInteractive(
      proSuperSubscription(),
    );

    fireEvent.click(
      await findByRole("button", { name: "Downgrade to Mighty" }),
    );
    fireEvent.click(await findByTestId("confirm-package-switch-button"));

    await waitFor(() => expect(changePackageCall).not.toBeNull());
    // Flush the rejected mutation so any erroneous close would have committed.
    await act(async () => {
      await Promise.resolve();
    });
    // The dialog stays open (the hook already toasted); the takeover never opens.
    expect(queryByTestId("confirm-package-switch-button")).not.toBeNull();
    expect(queryByTestId("resize-takeover")).toBeNull();
  });
});

// A cancelling or non-entitlement-status Pro sub can't switch in place — the
// change-package endpoint would 4xx. Clicking a package CTA must route it to the
// billing manage/cancel surface (`?adjust_plan`) instead of posting
// change-package, matching the plan-card banner's fallback.
describe("PlansPage — ineligible Pro subs route to manage", () => {
  const ineligible: Array<[string, SubscriptionResponse]> = [
    ["cancelling", { ...proMightySubscription(), cancel_at_period_end: true }],
    [
      "non-entitlement status",
      { ...proMightySubscription(), status: "unpaid" },
    ],
  ];

  for (const [label, subscription] of ineligible) {
    test(`a ${label} Pro sub's package CTA routes to manage, not change-package`, async () => {
      const { findByRole, findByTestId } = renderInteractive(subscription);

      // From Mighty, "Go Super" is the Super column's upgrade CTA.
      fireEvent.click(await findByRole("button", { name: "Go Super" }));

      const loc = await findByTestId("loc");
      await waitFor(() =>
        expect(loc.textContent).toBe(
          "/assistant/settings/usage?tab=billing&adjust_plan",
        ),
      );
      expect(changePackageCall).toBeNull();
      expect(upgradeCall).toBeNull();
    });
  }
});

// A Custom sub — one with no package pin, or a customized (diverged) pin — has
// no catalog rank. Every named card is a switch target: the confirm dialog uses
// direction-neutral copy, and a successful switch opens the provisioning
// takeover. A customized sub can even re-pin its own key (revert to stock).
describe("PlansPage — Custom Pro subs switch via neutral confirm", () => {
  function proUnpinnedSubscription(): SubscriptionResponse {
    return {
      plan_id: "pro",
      status: "active",
      renewal_date: null,
      current_period_start: null,
      current_period_end: "2026-07-10T00:00:00Z",
      cancel_at_period_end: false,
      cancel_at: null,
      package: null,
      entitlements: { managed_email: false, phone_number: false },
    };
  }

  function proCustomizedMightySubscription(): SubscriptionResponse {
    return {
      ...proMightySubscription(),
      package: { key: "mighty", name: "Mighty", version: 1, customized: true },
    };
  }

  test("an unpinned Pro sub's card opens the neutral 'Switch to' confirm and posts change-package", async () => {
    const { findByRole, findByText, findByTestId } = renderInteractive(
      proUnpinnedSubscription(),
    );

    // With no pin the card carries its plain upgrade CTA ("Power Up" for Mighty).
    fireEvent.click(await findByRole("button", { name: "Power Up" }));

    // The direction-neutral switch confirm appears (not upgrade/downgrade copy).
    await findByText("Switch to Mighty");
    await findByText(SWITCH_CAPTION);

    fireEvent.click(await findByTestId("confirm-package-switch-button"));

    await waitFor(() => expect(changePackageCall).not.toBeNull());
    expect(changePackageCall!.body).toEqual({ package: "mighty" });
    const takeover = await findByTestId("resize-takeover");
    expect(takeover.getAttribute("data-mode")).toBe("resize");
    // No rank to compare against, so the takeover states a neutral change.
    expect(takeoverResizeContext?.direction).toBe("change");
    // And for the same reason its own ceiling can sit anywhere relative to the
    // target's, so the switch has to prove the restart rather than assume none.
    expect(takeoverResizeContext?.canLowerResources).toBe(true);
    expect(upgradeCall).toBeNull();
  });

  test("a customized-pinned sub can re-select its own package (revert to stock), no 'current' short-circuit", async () => {
    const { findByRole, findByText, findByTestId } = renderInteractive(
      proCustomizedMightySubscription(),
    );

    // The customized sub's own Mighty card is not "current" — its CTA is live.
    fireEvent.click(await findByRole("button", { name: "Power Up" }));

    await findByText("Switch to Mighty");
    fireEvent.click(await findByTestId("confirm-package-switch-button"));

    await waitFor(() => expect(changePackageCall).not.toBeNull());
    expect(changePackageCall!.body).toEqual({ package: "mighty" });
  });

  test("a Custom sub's Free card is a downgrade and no named card is current", () => {
    const html = renderStatic(proCustomizedMightySubscription(), fullCatalog());
    // Pro → Free is always a downgrade.
    expect(html).toContain("Downgrade to Base");
    expect(html).not.toContain("Start Free");
    // A Custom sub has no catalog rank, so no named column card is its current
    // plan. The Custom row's own current-plan tag is gated on the onboarding
    // read, which a single-pass static render never resolves — the interactive
    // "Custom row current-plan marker" suite covers that tag.
    expect(html).not.toContain("Current Plan");
  });
});

// A custom Pro sub (unpinned, customized, or legacy) is represented by the
// Custom row, not any named card: the row is marked as their current plan and
// summarizes the tiers they actually hold. Base and clean-pinned subs — whose
// current plan IS a named card — see no marker on the Custom row.
describe("PlansPage — Custom row current-plan marker", () => {
  function proCustomizedWithCredits(): SubscriptionResponse {
    return {
      ...proMightySubscription(),
      package: { key: "mighty", name: "Mighty", version: 1, customized: true },
      selected_credit_tier: "credits_50",
    };
  }

  // A legacy/unpinned Pro sub carries no package at all, so it too is a Custom
  // sub represented by the Custom row rather than any named card.
  function proUnpinnedWithCredits(): SubscriptionResponse {
    return {
      ...proMightySubscription(),
      package: null,
      selected_credit_tier: "credits_50",
    };
  }

  test("a custom Pro sub sees the Custom row marked current with a tier summary", async () => {
    // onboarding() supplies medium machine / 10 GB; the sub carries credits_50.
    const { findByText } = renderInteractive(proCustomizedWithCredits(), {
      plans: customCatalog(),
    });

    await findByText("Your Current Plan");
    await findByText("Medium Machine · 10 GB · 50 credits");
  });

  test("a legacy/unpinned Pro sub sees the Custom row marked current with a tier summary", async () => {
    // No package pin — the same Custom-row current marker as the customized case.
    const { findByText } = renderInteractive(proUnpinnedWithCredits(), {
      plans: customCatalog(),
    });

    await findByText("Your Current Plan");
    await findByText("Medium Machine · 10 GB · 50 credits");
  });

  test("a custom sub holding a deprecated credit tier shows a derived credit label", async () => {
    // credits_45 is a valid tier the sub holds but the catalog no longer lists,
    // so the summary derives "45 credits" from the key instead of dropping it.
    const { findByText } = renderInteractive(
      { ...proCustomizedWithCredits(), selected_credit_tier: "credits_45" },
      { plans: customCatalog() },
    );

    await findByText("Your Current Plan");
    await findByText("Medium Machine · 10 GB · 45 credits/mo");
  });

  test("a clean-pinned Pro sub sees no marker on the Custom row", async () => {
    const { findByRole, queryByText } = renderInteractive(
      proMightySubscription(),
      { plans: customCatalog() },
    );

    // The body is mounted once the Configure CTA is present.
    await findByRole("button", { name: "Configure" });
    expect(queryByText("Your Current Plan")).toBeNull();
  });

  test("a base user sees no marker on the Custom row", async () => {
    const { findByRole, queryByText } = renderInteractive(freeSubscription(), {
      plans: customCatalog(),
    });

    await findByRole("button", { name: "Configure" });
    expect(queryByText("Your Current Plan")).toBeNull();
  });

  test("a custom sub with no loaded current tiers shows no marker", async () => {
    // When the onboarding read yields no provisioned storage (e.g. it errors),
    // the row isn't marked current — no "Your Current Plan" tag next to a
    // degraded summary.
    const { findByRole, queryByText } = renderInteractive(
      proCustomizedWithCredits(),
      {
        plans: customCatalog(),
        onboardingData: onboarding({ selected_storage_gib: null }),
      },
    );

    await findByRole("button", { name: "Configure" });
    expect(queryByText("Your Current Plan")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pro custom plan — change-tier dispatch via the Configure modal
// ---------------------------------------------------------------------------

/** A full catalog whose Pro plan carries the tier lists the custom modal needs. */
function customCatalog(): PlanListResponse {
  return {
    plans: [
      {
        id: "base",
        name: "Free",
        price_cents: 0,
        billing_interval: "month",
        included_features: [],
      },
      {
        id: "pro",
        name: "Pro",
        base_lookup_key: "pro_base",
        base_price_cents: 2000,
        billing_interval: "month",
        included_features: [],
        machine_tiers: [
          {
            tier: "medium",
            label: "medium",
            price_cents: 3500,
            lookup_key: "machine_m",
            cpu_limit: "2.5",
            memory_gib: 5,
            description: "Medium machine (2.5 vCPU, 5 GiB)",
          },
          {
            tier: "large",
            label: "large",
            price_cents: 6000,
            lookup_key: "machine_l",
            cpu_limit: "4",
            memory_gib: 8,
            description: "Large machine (4 vCPU, 8 GiB)",
          },
        ],
        storage_tiers: [
          {
            tier: "xs",
            label: "10 GB",
            storage_gib: 10,
            price_cents: 500,
            lookup_key: "storage_10",
            legacy: false,
          },
          {
            tier: "s",
            label: "30 GB",
            storage_gib: 30,
            price_cents: 1000,
            lookup_key: "storage_30",
            legacy: false,
          },
        ],
        credit_tiers: [
          {
            tier: "credits_50",
            label: "50 credits",
            credits_usd: 50,
            price_cents: 5000,
            lookup_key: "credits_50",
            legacy: false,
          },
        ],
        packages: [MIGHTY, SUPER, ULTRA],
      },
    ],
  };
}

/**
 * A catalog whose only 10 GB storage tier is legacy. A Pro sub sitting on it
 * can't be represented by the (legacy-filtered) modal storage picker, yet
 * Configure must still open the modal rather than bounce to the manage surface.
 */
function legacyStorageCatalog(): PlanListResponse {
  const catalog = customCatalog();
  const pro = catalog.plans.find((p) => p.id === "pro") as ProPlan;
  // storage_tiers[0] is the 10 GB tier.
  pro.storage_tiers[0] = {
    ...pro.storage_tiers[0],
    lookup_key: "storage_10_legacy",
    legacy: true,
  };
  return catalog;
}

function openSelect(ariaLabel: string): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${ariaLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a "${ariaLabel}" dropdown trigger`);
  }
  fireEvent.click(trigger);
}

/** Clicks the open-menu option whose text starts with `label`. */
function selectOption(selectLabel: string, optionLabel: string): void {
  openSelect(selectLabel);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => (o.textContent?.trim() ?? "").startsWith(optionLabel));
  if (!option) {
    throw new Error(`expected option "${optionLabel}"`);
  }
  fireEvent.click(option);
}

function continueButton(): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === "Continue");
  if (!button) {
    throw new Error("expected a Continue button");
  }
  return button;
}

describe("PlansPage — Pro custom plan (change-tier)", () => {
  test("an eligible Pro sub's Configure opens the white modal, not adjust_plan", async () => {
    const { findByRole, getByTestId, getByText } = renderInteractive(
      proMightySubscription(),
      { plans: customCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    getByText("Create a custom plan");
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(upgradeCall).toBeNull();
  });

  test("Continue dispatches change-tier for the changed dims and opens the resize takeover", async () => {
    // Current config is medium machine / 10 GB (xs) storage / no credits.
    const { findByRole, findByTestId } = renderInteractive(
      proMightySubscription(),
      { plans: customCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    selectOption("Storage", "10 GB");
    selectOption("Credit bundle", "50 credits");
    fireEvent.click(continueButton());

    await waitFor(() => expect(machineTierCall).not.toBeNull());
    expect(machineTierCall!.body).toEqual({ machine_tier: "large" });
    expect(creditTierCall!.body).toEqual({ credit_tier: "credits_50" });
    // Storage is unchanged, so no storage-tier request fires.
    expect(storageTierCall).toBeNull();

    // A machine change resizes the assistant, so the takeover opens; checkout
    // (which no-ops for active Pro) is never touched.
    const takeover = await findByTestId("resize-takeover");
    expect(takeover.getAttribute("data-mode")).toBe("resize");
    // The bundle changed alongside the machine, so the tier move is threaded
    // through too, from the pre-change tier the sub held.
    expect(takeoverResizeContext?.credits).toEqual({
      fromTier: null,
      toTier: "credits_50",
    });
    // The pod's own machine and disk are the from-sides, not the billed tiers.
    expect(takeoverResizeContext?.fromSnapshot).toEqual({
      machineSize: "large",
      storageGib: 10,
    });
    // A per-dimension edit can move dimensions in both directions at once.
    expect(takeoverResizeContext?.direction).toBe("change");
    // Medium → Large raises the ceiling, so nothing has to shrink.
    expect(takeoverResizeContext?.canLowerResources).toBe(false);
    expect(upgradeCall).toBeNull();
  });

  test("a credits-only Continue opens the takeover, not just a toast", async () => {
    // Current config is medium machine / 10 GB (xs) storage / no credits; change
    // only the credit bundle.
    const { findByRole, findByTestId } = renderInteractive(
      proMightySubscription(),
      { plans: customCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    selectOption("Credit bundle", "50 credits");
    fireEvent.click(continueButton());

    await waitFor(() => expect(creditTierCall).not.toBeNull());
    expect(creditTierCall!.body).toEqual({ credit_tier: "credits_50" });
    // Machine and storage are unchanged, so no resource-tier request fires.
    expect(machineTierCall).toBeNull();
    expect(storageTierCall).toBeNull();

    // A credit-only change owes no provisioning but still opens the takeover for
    // a readable confirmation moment.
    const takeover = await findByTestId("resize-takeover");
    expect(takeover.getAttribute("data-mode")).toBe("resize");
    // The tier move is threaded through so the takeover can state it; a
    // credit-only change resolves straight to the terminal phase.
    expect(takeoverResizeContext?.credits).toEqual({
      fromTier: null,
      toTier: "credits_50",
    });
    // Credits are not a provisioned resource and no ceiling moved, so the
    // takeover keeps the inference that lets met targets resolve it straight
    // away. The neutral "change" direction must not cost it that.
    expect(takeoverResizeContext?.canLowerResources).toBe(false);
    expect(upgradeCall).toBeNull();
  });

  test("a storage-only Continue keeps the fast no-op inference", async () => {
    // Volumes only ever grow, so a storage edit can't lower a ceiling either.
    const { findByRole, findByTestId } = renderInteractive(
      proMightySubscription(),
      { plans: customCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    selectOption("Storage", "30 GB");
    fireEvent.click(continueButton());

    await waitFor(() => expect(storageTierCall).not.toBeNull());
    expect(storageTierCall!.body).toEqual({ storage_tier: "s" });
    expect(machineTierCall).toBeNull();
    expect(creditTierCall).toBeNull();

    await findByTestId("resize-takeover");
    expect(takeoverResizeContext?.canLowerResources).toBe(false);
  });

  test("a machine downgrade makes the takeover prove the restart", async () => {
    // The sub holds a Large ceiling and drops to Medium, so the server caps the
    // pod down. A machine downgrade owes no grow, so it opens the takeover only
    // alongside the credit change here, and while that takeover is up the
    // cap-down is rolling out with its targets already reading met.
    const { findByRole, findByTestId } = renderInteractive(
      proMightySubscription(),
      {
        plans: customCatalog(),
        onboardingData: onboarding({ max_machine_tier: "large" }),
      },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Medium machine (2.5 vCPU, 5 GiB)");
    selectOption("Credit bundle", "50 credits");
    fireEvent.click(continueButton());

    await waitFor(() => expect(machineTierCall).not.toBeNull());
    expect(machineTierCall!.body).toEqual({ machine_tier: "medium" });

    await findByTestId("resize-takeover");
    // The copy stays neutral; only the ceiling question flips.
    expect(takeoverResizeContext?.direction).toBe("change");
    expect(takeoverResizeContext?.canLowerResources).toBe(true);
  });

  test("a machine-only Continue threads no credits chip", async () => {
    const { findByRole, findByTestId } = renderInteractive(
      proMightySubscription(),
      { plans: customCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    fireEvent.click(continueButton());

    await waitFor(() => expect(machineTierCall).not.toBeNull());
    await findByTestId("resize-takeover");
    expect(creditTierCall).toBeNull();
    expect(takeoverResizeContext?.credits).toBeNull();
  });

  // Configure always opens the in-place custom modal for a Pro sub, whatever the
  // sub's eligibility or tier legacy status. An ineligible or legacy-tier sub
  // that then tries to apply a change surfaces the backend's 4xx as a toast (the
  // modal stays open) instead of being pre-emptively bounced to the manage
  // surface.
  test("an ineligible (cancelling) Pro sub's Configure opens the modal, not adjust_plan", async () => {
    const { findByRole, getByTestId, getByText } = renderInteractive(
      { ...proMightySubscription(), cancel_at_period_end: true },
      { plans: customCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    getByText("Create a custom plan");
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(machineTierCall).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("a base user's Configure opens the custom modal (checkout path), not adjust_plan", async () => {
    const { findByRole, getByTestId, getByText } = renderInteractive(
      freeSubscription(),
      { plans: customCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    getByText("Create a custom plan");
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    // Checkout only fires once the modal's Continue is pressed.
    expect(upgradeCall).toBeNull();
  });

  test("a Pro sub on a legacy storage tier's Configure opens the modal, not adjust_plan", async () => {
    const { findByRole, getByTestId, getByText } = renderInteractive(
      proMightySubscription(),
      { plans: legacyStorageCatalog() },
    );

    fireEvent.click(await findByRole("button", { name: "Configure" }));

    getByText("Create a custom plan");
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(machineTierCall).toBeNull();
    expect(upgradeCall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// obscure-credits flag: the package rows never name a credit amount
// ---------------------------------------------------------------------------

/** Drives the `obscure-credits` client flag the way the app's LD sync does. */
function setObscureCredits(value: boolean): void {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: value }, null);
  });
}

describe("PlansPage: obscure-credits flag", () => {
  afterEach(() => {
    setObscureCredits(false);
  });

  test("flag on: every package row reads as the package's usage, never as credits", async () => {
    setObscureCredits(true);
    const { findByText, getByText, queryByText, container } =
      renderInteractive(freeSubscription());

    // The name-derived usage rows, matching the plan card's obscured chip.
    await findByText("Mighty usage, reset monthly");
    getByText("Super usage, reset monthly");
    getByText("Ultra usage, reset monthly");
    // The obscured wording wins even though the fixtures carry a usage_label.
    expect(queryByText("Mighty Usage included")).toBeNull();
    // No card names a credit amount.
    expect(container.textContent).not.toContain("in credits included");
  });

  test("flag on: a package with no usage_label still never falls back to credits", async () => {
    setObscureCredits(true);
    const { findByText, container } = renderInteractive(freeSubscription(), {
      plans: plansWith([makeProPackage({ usage_label: null })]),
    });

    await findByText("Mighty usage, reset monthly");
    expect(container.textContent).not.toContain("in credits included");
  });
});
