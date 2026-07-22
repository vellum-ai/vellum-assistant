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

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, useLocation } from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as platformGateMod from "@/hooks/use-platform-gate";
import * as toastMod from "@vellumai/design-library/components/toast";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  PackageChangeResponse,
  PlanListResponse,
  ProPackage,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

const CHECKOUT_URL = "https://stripe.test/checkout/session";

type Captured = { body?: unknown };
let changePackageCall: Captured | null = null;
let upgradeCall: Captured | null = null;
let openedUrl: string | null = null;
// Success-toast messages captured from the mocked toast module — lets the
// downgrade path assert its confirmation toast without rendering the Toaster.
const toastSuccessCalls: string[] = [];
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
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({ data: subscriptionFixture, response: { ok: true } }),
  organizationsBillingPlansRetrieve: () =>
    Promise.resolve({ data: plansFixture, response: { ok: true } }),
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

// Render avatar placeholders; skip the lazy compositor bundle in the DOM test.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

// Stand in for the provisioning takeover so the test can assert it was revealed
// without driving its own resize queries.
mock.module("@/domains/settings/components/tier-upgrade-resize-modal", () => ({
  TierUpgradeResizeModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="resize-takeover" /> : null,
}));

// Capture success toasts so the downgrade path can assert its confirmation
// message; keep the real module's other methods (error, etc.) intact.
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastMod,
  toast: {
    ...toastMod.toast,
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
  },
}));

const { PlansPage } = await import("./plans-page");
const { getPlanTierCopy } = await import("./plans-copy");

/** A fully-typed Pro package with Mighty defaults; override per tier. */
function makePackage(overrides: Partial<ProPackage>): ProPackage {
  return {
    key: "mighty",
    name: "Mighty",
    description: "",
    version: 1,
    machine_tier: null,
    storage_tier: "xs",
    credit_tier: "credits_25",
    machine_size: null,
    storage_gib: 10,
    credits_usd: 25,
    include_platform_fee: false,
    base_price_cents: 0,
    machine_price_cents: 0,
    storage_price_cents: 0,
    credit_price_cents: 0,
    total_price_cents: 3000,
    ...overrides,
  };
}

const MIGHTY = makePackage({});
const SUPER = makePackage({
  key: "super",
  name: "Super",
  machine_size: "medium",
  storage_gib: 25,
  credits_usd: 50,
  total_price_cents: 10000,
});
const ULTRA = makePackage({
  key: "ultra",
  name: "Ultra",
  machine_size: "large",
  storage_gib: 50,
  credits_usd: 100,
  total_price_cents: 20000,
});

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
    expect(html).toContain("Plans designed to empower you");
    expect(html).toContain("Free");
    expect(html).toContain("Mighty");
    expect(html).toContain("Super");
    expect(html).toContain("Ultra");
  });

  test("formats prices from the catalog totals (and $0 for free)", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    expect(html).toContain("$0/month");
    expect(html).toContain("$30/month");
    expect(html).toContain("$100/month");
    expect(html).toContain("$200/month");
  });

  test("shows the Most Popular badge exactly once", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    // The badge text is "Most Popular"; the all-caps look is CSS `uppercase`,
    // which renderToStaticMarkup does not apply.
    expect(count(html, /Most Popular/g)).toBe(1);
  });

  test("derives feature rows from the fixture (storage, credits, machine)", () => {
    const html = renderStatic(freeSubscription(), fullCatalog());
    // Storage rows.
    expect(html).toContain("10 GiB Storage");
    expect(html).toContain("25 GiB Storage");
    expect(html).toContain("50 GiB Storage");
    // Free plan's baseline storage (FREE_STORAGE_GIB).
    expect(html).toContain("4 GiB Storage");
    // Credits row, formatted from credits_usd.
    expect(html).toContain("$25 in credits per month");
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
    expect(html).toContain("Billed monthly");
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
    expect(html).toContain("Downgrade to Free");
    expect(html).not.toContain("Start Free");
    // Super and Ultra sit above Mighty, so they keep their upgrade CTAs.
    expect(html).toContain("Go Super");
    expect(html).toContain("Unleash Ultra");
    expect(count(html, /disabled=""/g)).toBe(1);
  });
});

describe("PlansPage — empty catalog (pro-packages flag off)", () => {
  test("renders the loading fallback, not the pricing grid", () => {
    // The redirect fires in a useEffect (not run by renderToStaticMarkup), so
    // the pre-redirect markup is the loading spinner.
    const html = renderStatic(freeSubscription(), plansWith([]));
    expect(html).toContain("Loading plans");
    expect(html).not.toContain("Plans designed to empower you");
    expect(html).not.toContain("Mighty");
    expect(html).not.toContain("Power Up");
    expect(html).not.toContain("Custom Plan");
  });
});

describe("getPlanTierCopy", () => {
  test("returns tier copy including the most-popular flag and CTA", () => {
    expect(getPlanTierCopy("mighty")?.cta).toBe("Power Up");
    expect(getPlanTierCopy("super")?.mostPopular).toBe(true);
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

function renderInteractive(subscription: SubscriptionResponse) {
  subscriptionFixture = subscription;
  plansFixture = fullCatalog();
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
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), fullCatalog());
  return render(
    <MemoryRouter initialEntries={["/assistant/plans"]}>
      <QueryClientProvider client={client}>
        <PlansPage />
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  changePackageCall = null;
  upgradeCall = null;
  openedUrl = null;
  changePackageAutoResolve = true;
  changePackageData = {
    status: "ok",
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
  };
  changePackageError = null;
  subscriptionFixture = null;
  plansFixture = null;
  toastSuccessCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("PlansPage — Pro package switch (change-package)", () => {
  test("Super → Mighty downgrade confirms, then calls change-package without opening the takeover", async () => {
    const { findByRole, findByTestId, getByTestId, queryByTestId } =
      renderInteractive(proSuperSubscription());

    // Click the Mighty column's downgrade CTA (below Super).
    fireEvent.click(await findByRole("button", { name: "Downgrade to Mighty" }));

    // The reconfirm dialog appears; confirm it.
    fireEvent.click(await findByTestId("confirm-package-switch-button"));

    await waitFor(() => expect(changePackageCall).not.toBeNull());
    expect(changePackageCall!.body).toEqual({ package: "mighty" });

    // A downgrade caps the machine down immediately, so the dialog closes on a
    // success toast and the provisioning takeover never opens.
    await waitFor(() =>
      expect(queryByTestId("confirm-package-switch-button")).toBeNull(),
    );
    expect(toastSuccessCalls).toEqual(["Downgraded to Mighty."]);
    expect(queryByTestId("resize-takeover")).toBeNull();
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(upgradeCall).toBeNull();
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

    await findByTestId("resize-takeover");
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
  });

  test("Pro → Free downgrade routes to the manage/cancel flow, not change-package", async () => {
    const { findByRole, findByTestId } = renderInteractive(
      proSuperSubscription(),
    );

    // Below Super, Free reads "Downgrade to Free". Cancellation can't go through
    // the package-only change-package endpoint, so it routes to `?adjust_plan`.
    fireEvent.click(await findByRole("button", { name: "Downgrade to Free" }));

    const loc = await findByTestId("loc");
    await waitFor(() =>
      expect(loc.textContent).toBe(
        "/assistant/settings/usage?tab=billing&adjust_plan",
      ),
    );
    expect(changePackageCall).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("base user CTA starts Stripe checkout, not change-package", async () => {
    const { findByRole } = renderInteractive(freeSubscription());

    fireEvent.click(await findByRole("button", { name: "Go Super" }));

    await waitFor(() => expect(upgradeCall).not.toBeNull());
    expect(upgradeCall!.body).toMatchObject({
      target_plan_id: "pro",
      package: "super",
      confirm: true,
    });
    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(changePackageCall).toBeNull();
  });

  test("the confirm CTA is disabled while a switch is pending", async () => {
    changePackageAutoResolve = false;
    const { findByRole, findByTestId } = renderInteractive(proSuperSubscription());

    fireEvent.click(await findByRole("button", { name: "Downgrade to Mighty" }));
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

    fireEvent.click(await findByRole("button", { name: "Downgrade to Mighty" }));
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

// A Pro sub that isn't cleanly packaged (customized, cancelling, or in a
// non-entitlement status) can't switch in place — the change-package endpoint
// would 4xx. Clicking a package CTA must route it to the billing manage/cancel
// surface (`?adjust_plan`) instead of posting change-package, matching the
// plan-card banner's fallback.
describe("PlansPage — ineligible Pro subs route to manage", () => {
  const ineligible: Array<[string, SubscriptionResponse]> = [
    [
      "customized",
      {
        ...proMightySubscription(),
        package: { key: "mighty", name: "Mighty", version: 1, customized: true },
      },
    ],
    ["cancelling", { ...proMightySubscription(), cancel_at_period_end: true }],
    ["non-entitlement status", { ...proMightySubscription(), status: "unpaid" }],
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
