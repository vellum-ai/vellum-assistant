/**
 * Tests for the PlanCard: verifies the plan name, renewal text, the plan-row
 * action button, and the recommended-upgrade banner render correctly, plus the
 * action button's navigation wiring. The card shows no credit bundle label and
 * no invoices button; invoices render in an inline table on the billing page.
 *
 * Content tests pre-populate the React Query cache so the card's `useQuery`
 * calls resolve synchronously — `renderToStaticMarkup` is single-pass, so a
 * pending query would otherwise report `isLoading` and render the spinner.
 * The action-button tests render interactively (happy-dom) and mock
 * `useNavigate` so the takeover navigation can be asserted without a Router;
 * the avatar compositor is mocked to a same-size placeholder.
 */

import * as reactRouter from "react-router";

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

import * as sdkGen from "@/generated/api/sdk.gen";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  PackageChangeResponse,
  PlanListResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import * as runtimeBrowser from "@/runtime/browser";
import { PLAN_TIER_COPY } from "@/domains/settings/billing/plans/plans-copy";
import { routes } from "@/utils/routes";

// Capture navigate() targets so the action-button wiring can be asserted
// without a live Router.
let navigateArgs: Array<[unknown, unknown]> = [];
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => (to: unknown, opts: unknown) => {
    navigateArgs.push([to, opts]);
  },
}));

// Render avatar placeholders; skip the lazy compositor bundle in the DOM test.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

// Drive the billing mutations from the SDK boundary (mirrors adjust-plan-modal's
// harness): capture the request bodies and control each resolution. The retrieve
// functions back the post-change invalidation refetch so the run stays hermetic.
type Captured = { body?: unknown };
let upgradeCall: Captured | null = null;
let upgradeResponse: Record<string, unknown> = {
  status: "redirect",
  checkout_url: "https://checkout.example.com/session",
};
let changePackageBody: { package: string } | null = null;
let changePackageImpl: () => Promise<{
  data: PackageChangeResponse;
  response: { ok: boolean };
}> = async () => ({
  data: {
    status: "ok",
    package: { key: "super", name: "Super", version: 1, customized: false },
  },
  response: { ok: true },
});
let currentSub: SubscriptionResponse = baseSubscription();
let currentPlans: PlanListResponse = basePlansResponse();

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCall = opts;
    return Promise.resolve({ data: upgradeResponse, response: { ok: true } });
  },
  organizationsBillingSubscriptionChangePackageCreate: (opts: Captured) => {
    changePackageBody = opts.body as { package: string };
    return changePackageImpl();
  },
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({ data: currentSub, response: { ok: true } }),
  organizationsBillingPlansRetrieve: () =>
    Promise.resolve({ data: currentPlans, response: { ok: true } }),
  organizationsBillingSubscriptionOnboardingRetrieve: () =>
    Promise.resolve({ data: {}, response: { ok: true } }),
}));

// Capture the Stripe checkout redirect instead of opening a browser.
let openedUrl: string | null = null;
mock.module("@/runtime/browser", () => ({
  ...runtimeBrowser,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
  openUrlFinishedListener: () => () => {},
}));

const { PlanCard } = await import("./plan-card");

function basePlansResponse(): PlanListResponse {
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
        packages: [
          {
            key: "mighty",
            name: "Mighty",
            description:
              "10 GB of storage and $25 in monthly credits on the standard machine.",
            version: 1,
            machine_tier: null,
            storage_tier: "xs",
            credit_tier: "credits_25",
            machine_size: null,
            storage_gib: 10,
            credits_usd: 25,
            include_platform_fee: false,
            base_price_cents: 4000,
            machine_price_cents: 0,
            storage_price_cents: 0,
            credit_price_cents: 0,
            total_price_cents: 4000,
          },
        ],
      },
    ],
  };
}

function baseSubscription(): SubscriptionResponse {
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

/** Catalog with both Mighty and Super, so `nextPackageUp("mighty")` → Super. */
function plansWithSuper(): PlanListResponse {
  const plans = basePlansResponse();
  const pro = plans.plans.find((p) => p.id === "pro");
  if (pro && "packages" in pro && pro.packages) {
    pro.packages.push({
      key: "super",
      name: "Super",
      description:
        "Medium machine, 30 GB of storage, and $45 in monthly credits.",
      version: 1,
      machine_tier: "medium",
      storage_tier: "s",
      credit_tier: "credits_45",
      machine_size: "medium",
      storage_gib: 30,
      credits_usd: 45,
      include_platform_fee: true,
      base_price_cents: 1000,
      machine_price_cents: 3500,
      storage_price_cents: 1000,
      credit_price_cents: 4500,
      total_price_cents: 10000,
    });
  }
  return plans;
}

/** A subscriber currently on the Mighty Pro package. */
function proMightySubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_end: "2026-08-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
  };
}

/** A catalog with the `pro-packages` flag off — the Pro plan has no packages. */
function emptyCatalogPlans(): PlanListResponse {
  const plans = basePlansResponse();
  const pro = plans.plans.find((p) => p.id === "pro");
  if (pro && "packages" in pro) {
    pro.packages = [];
  }
  return plans;
}

function makeClient(
  subscription: SubscriptionResponse,
  plans: PlanListResponse,
): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
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
  return client;
}

function renderCard(
  subscription: SubscriptionResponse,
  plans: PlanListResponse,
): string {
  const client = makeClient(subscription, plans);
  return renderToStaticMarkup(
    // MemoryRouter supplies the router context PlanCard's useNavigate needs.
    <reactRouter.MemoryRouter>
      <QueryClientProvider client={client}>
        <PlanCard onManage={() => {}} />
      </QueryClientProvider>
    </reactRouter.MemoryRouter>,
  );
}

function renderCardInteractive(
  subscription: SubscriptionResponse,
  plans: PlanListResponse,
  onManage: () => void,
  onTierUpgraded?: () => void,
) {
  // Back the post-change invalidation refetch with the same fixtures.
  currentSub = subscription;
  currentPlans = plans;
  const client = makeClient(subscription, plans);
  // useNavigate is mocked, so no Router wrapper is needed here.
  return render(
    <QueryClientProvider client={client}>
      <PlanCard onManage={onManage} onTierUpgraded={onTierUpgraded} />
    </QueryClientProvider>,
  );
}

/** Waits for the PackageSwitchConfirmModal (portaled) to open. */
async function findConfirmDialogButton(): Promise<HTMLButtonElement> {
  return await waitFor(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      "[data-testid='confirm-package-switch-button']",
    );
    if (!btn) {
      throw new Error("confirm dialog not open");
    }
    return btn;
  });
}

beforeEach(() => {
  navigateArgs = [];
  upgradeCall = null;
  upgradeResponse = {
    status: "redirect",
    checkout_url: "https://checkout.example.com/session",
  };
  changePackageBody = null;
  changePackageImpl = async () => ({
    data: {
      status: "ok",
      package: { key: "super", name: "Super", version: 1, customized: false },
    },
    response: { ok: true },
  });
  openedUrl = null;
});

afterEach(() => {
  cleanup();
});

describe("PlanCard", () => {
  test("shows the plan name and renewal text for a base plan", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Free");
    expect(html).toContain("Your Current Plan");
    expect(html).toContain("plan-card-renews");
    expect(html).toContain("auto renew");
  });

  test("shows the upgrade button for a base plan", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-card-upgrade-button");
    expect(html).toContain("View All Plans");
  });

  test("does not render the invoices button (moved to inline table)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).not.toContain("plan-card-invoices-button");
  });

  test("renders the recommended-upgrade banner (Mighty from Free)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Recommended");
    expect(html).toContain("Mighty");
  });

  test("no upgrade banner when the package catalog is empty (flag off)", () => {
    const html = renderCard(baseSubscription(), emptyCatalogPlans());
    // Only the current card renders; the recommended card (and its CTA) is gone.
    expect(html).not.toContain("recommended-upgrade-button");
  });

  test("Free current card is chip-less; recommended shows the summary chip", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    // The current (Free) card is now a minimal centered card with NO spec chips:
    // none of the free-baseline chip labels appear.
    expect(html).not.toContain("$0 credits");
    expect(html).not.toContain("4 GB");
    expect(html).not.toContain("Small Machine");
    // The recommended (Mighty) card shows the single summary chip, replacing the
    // old absolute per-resource chips (machine · credits · storage). Free→Mighty
    // stays on the Small baseline, so the chip omits the machine claim.
    expect(html).toContain("more credits and storage");
    expect(html).not.toContain("stronger machine");
    expect(html).not.toContain("$25 credits");
    expect(html).not.toContain("10 GB");
    expect(html).not.toContain("vCPU");
    // The centered free card still shows its "Your Current Plan" tag and its real
    // tagline — the tagline follows "known plan", not "has chips".
    expect(html).toContain("Your Current Plan");
    expect(html).toContain(PLAN_TIER_COPY.free.tagline);
  });

  test("Mighty → Super: current keeps its chips, recommended shows the summary chip", () => {
    const html = renderCard(proMightySubscription(), plansWithSuper());
    // On Mighty, the recommended upgrade is the next catalog package, Super.
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Recommended");
    expect(html).toContain("Super");
    // The recommended (Super) card shows the single summary chip, not Super's
    // absolute per-resource chips.
    expect(html).toContain("more credits, storage, and a stronger machine");
    expect(html).not.toContain("$45 credits");
    expect(html).not.toContain("30 GB");
    // The current (Mighty) card keeps its absolute chips.
    expect(html).toContain("$25 credits");
    expect(html).toContain("10 GB");
    expect(html).toContain("Small Machine");
    // The current-plan card shows the actual package name "Mighty" (not the
    // generic plan name "Pro").
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Mighty");
    expect(html).not.toContain("Pro");
  });

  test("an unpinned Custom sub's banner drops the stock upgrade framing", () => {
    // A legacy unpinned Pro sub's real tiers can diverge from any stock
    // package, so the banner offers the named plan neutrally: a "Switch plan"
    // tag and a "Switch to Mighty" CTA, with no "Recommended Upgrade" claim and
    // no stock price/resource deltas that could point the wrong way.
    const subscription: SubscriptionResponse = {
      ...proMightySubscription(),
      package: null,
    };
    const html = renderCard(subscription, plansWithSuper());
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Switch plan");
    expect(html).toContain("Switch to Mighty");
    // A neutral switch drops the "Recommended" tag and renders no chips on the
    // recommended card — not even the summary chip; the current "Custom" card
    // also has no knowable chips. Asserting on the "more credits" prefix covers
    // both the full and machine-less summary labels.
    expect(html).not.toContain("Recommended");
    expect(html).not.toContain("more credits");
  });

  test("a customized Pro sub's banner drops the stock upgrade framing", () => {
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    const html = renderCard(subscription, plansWithSuper());
    // Recommended package is Super (next after the Mighty pin), offered as a
    // neutral switch since the customized tiers can differ from stock Super.
    expect(html).toContain("Switch plan");
    expect(html).toContain("Switch to Super");
    expect(html).not.toContain("Recommended");
    // A neutral switch renders no summary chip either. The "more credits" prefix
    // covers both the full and machine-less summary labels.
    expect(html).not.toContain("more credits");
  });

  test("a base user's banner keeps the directional upgrade framing", () => {
    // Base → Pro is a genuine Stripe-checkout upgrade, so the recommended card
    // keeps its "Recommended" tag and the "Upgrade for … more" CTA.
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("Recommended");
    expect(html).toContain("Upgrade for");
    expect(html).not.toContain("Switch plan");
  });

  test("current-plan row labels a customized package as custom", () => {
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    const html = renderCard(subscription, plansWithSuper());
    // A customized plan reads just "Custom" — no stock-package prefix — so it
    // doesn't masquerade as a stock package.
    expect(html).toContain("Custom");
    expect(html).not.toContain("Mighty (Custom)");
    // Its specs are unknowable (no chips), so the stock Mighty tagline must not
    // render under the "Custom" name either — same gate as the chips.
    expect(html).not.toContain(PLAN_TIER_COPY.mighty.tagline);
  });

  test("current-plan row labels an unpinned Pro sub as custom", () => {
    // A legacy Pro sub with no pinned package reads "Custom", not the generic
    // plan name "Pro".
    const subscription: SubscriptionResponse = {
      ...proMightySubscription(),
      package: null,
    };
    const html = renderCard(subscription, plansWithSuper());
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Custom");
    expect(html).not.toContain("Pro");
    // `currentTier` falls back to "free" for an unpinned sub, but its specs are
    // unknowable (no chips), so the stock free tagline must not leak in under
    // the "Custom" name.
    expect(html).not.toContain(PLAN_TIER_COPY.free.tagline);
  });

  test("a clean-pinned Pro sub whose package is absent from the catalog shows no chips", () => {
    // A clean pin on Mighty, but the catalog has no packages (e.g. the
    // `pro-packages` flag is off, or the pinned key isn't in this response). The
    // package lookup misses, so the current card's specs are unknowable and it
    // must render NO chips — crucially NOT the free baseline, which would
    // mislabel this paid Pro sub as $0 credits / 4 GB / Small Machine.
    const html = renderCard(proMightySubscription(), emptyCatalogPlans());
    // The current card still names the pinned package ("Mighty"), not "Custom".
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Mighty");
    // No free-baseline chips leak onto the paid sub's current card.
    expect(html).not.toContain("$0 credits");
    expect(html).not.toContain("4 GB");
    expect(html).not.toContain("Small Machine");
  });

  test("a free user's current card is centered, chip-less, and keeps its tagline", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    // The free current card is a minimal centered card: centering classes on the
    // card, its "Your Current Plan" tag, and the real free tagline, but NO chips.
    expect(html).toContain("justify-center");
    expect(html).toContain("Your Current Plan");
    expect(html).toContain(PLAN_TIER_COPY.free.tagline);
    expect(html).not.toContain("$0 credits");
    expect(html).not.toContain("4 GB");
    expect(html).not.toContain("Small Machine");
    // The recommended (Mighty) card shows the single summary chip. Free→Mighty
    // keeps the Small baseline machine, so the chip claims only credits/storage.
    expect(html).toContain("more credits and storage");
    expect(html).not.toContain("stronger machine");
  });
});

describe("PlanCard action button", () => {
  test("a Pro user's Manage click opens the plan-aware plans takeover", async () => {
    const onManage = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      proMightySubscription(),
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    // navigate() fires from the click handler; await it so the assertion never
    // races the handler's commit in the CI runner.
    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("a base user's View Plans click opens the plans takeover", async () => {
    const onManage = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      baseSubscription(),
      basePlansResponse(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-upgrade-button"));

    // navigate() fires from the click handler; await it so the assertion never
    // races the handler's commit in the CI runner.
    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("an empty catalog falls back to onManage (AdjustPlanModal)", async () => {
    const onManage = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      proMightySubscription(),
      emptyCatalogPlans(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    // The empty catalog wires the button to onManage; await it so the assertion
    // never races the handler's commit in the CI runner.
    await waitFor(() => {
      expect(onManage).toHaveBeenCalledTimes(1);
    });
    expect(navigateArgs).toEqual([]);
  });

  test("a customized Pro sub's Manage opens the plans takeover", async () => {
    const onManage = mock(() => {});
    // A customized pin routes to the takeover alongside every other Pro sub; the
    // takeover's own CTAs handle the customized state's transitions.
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("a Pro sub without a pinned package opens the plans takeover", async () => {
    const onManage = mock(() => {});
    // A legacy/unpinned Custom Pro sub routes to the takeover with the rest; the
    // takeover surfaces the Custom row as its current plan.
    const subscription = { ...proMightySubscription(), package: undefined };
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("a from-scratch custom Pro sub's Manage opens the plans takeover", async () => {
    const onManage = mock(() => {});
    // A Pro sub built from scratch — no stock lineage, pinned but customized —
    // routes to the takeover like every other Pro sub with a live catalog.
    const subscription = proMightySubscription();
    subscription.package = {
      key: "custom",
      name: "Custom",
      version: 1,
      customized: true,
    };
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("a cancelling custom Pro sub's Manage stays on the manage fallback", async () => {
    const onManage = mock(() => {});
    // A customized/unpinned sub pending cancellation keeps the manage modal,
    // which surfaces the cancellation state and the "Keep your Plan" action; the
    // takeover can't act on a cancelling sub.
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    subscription.cancel_at = "2026-08-23T12:36:05Z";
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    await waitFor(() => {
      expect(onManage).toHaveBeenCalledTimes(1);
    });
    expect(navigateArgs).toEqual([]);
  });

  test("a cancelling clean-pin Pro sub still opens the plans takeover", async () => {
    const onManage = mock(() => {});
    // A clean pin routes to the takeover even while cancelling; its package CTA
    // reaches the manage surface from there.
    const subscription = proMightySubscription();
    subscription.cancel_at = "2026-08-23T12:36:05Z";
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("an unpaid custom Pro sub's Manage stays on the manage fallback", async () => {
    const onManage = mock(() => {});
    // A custom sub in a non-entitlement status (e.g. unpaid) is switch-ineligible,
    // so it keeps the manage modal — the takeover would bounce every CTA back to
    // the manage surface.
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    subscription.status = "unpaid";
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-manage-button"));

    await waitFor(() => {
      expect(onManage).toHaveBeenCalledTimes(1);
    });
    expect(navigateArgs).toEqual([]);
  });
});

describe("PlanCard recommended upgrade — change-package", () => {
  test("a Pro user confirms then upgrades in place via change-package", async () => {
    const onTierUpgraded = mock(() => {});
    const { findByTestId, findByText } = renderCardInteractive(
      proMightySubscription(),
      plansWithSuper(),
      () => {},
      onTierUpgraded,
    );

    // The banner CTA opens a confirm dialog (no immediate mutation). A clean pin
    // keeps the directional upgrade copy.
    fireEvent.click(await findByTestId("recommended-upgrade-button"));
    await findByText("Upgrade to Super?");
    await findByText("You'll be charged the prorated difference now.");
    expect(changePackageBody).toBeNull();

    // Confirming posts the recommended package key to change-package.
    fireEvent.click(await findConfirmDialogButton());

    await waitFor(() => {
      if (!changePackageBody) {
        throw new Error("change-package not called");
      }
    });
    expect(changePackageBody).toEqual({ package: "super" });

    // On success the provisioning takeover is triggered — never the plans page.
    await waitFor(() => {
      expect(onTierUpgraded).toHaveBeenCalledTimes(1);
    });
    expect(navigateArgs).toEqual([]);
    expect(openedUrl).toBeNull();
  });

  test("the CTA and confirm button are disabled while change-package is pending", async () => {
    let release!: (value: {
      data: PackageChangeResponse;
      response: { ok: boolean };
    }) => void;
    changePackageImpl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const onTierUpgraded = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      proMightySubscription(),
      plansWithSuper(),
      () => {},
      onTierUpgraded,
    );

    fireEvent.click(await findByTestId("recommended-upgrade-button"));
    fireEvent.click(await findConfirmDialogButton());

    // In-flight: the confirm button and the banner CTA both disable.
    await waitFor(() => {
      const confirm = document.querySelector<HTMLButtonElement>(
        "[data-testid='confirm-package-switch-button']",
      );
      if (!confirm?.disabled) {
        throw new Error("confirm not disabled yet");
      }
    });
    const banner = (await findByTestId(
      "recommended-upgrade-button",
    )) as HTMLButtonElement;
    expect(banner.disabled).toBe(true);

    // Resolving completes the flow and raises the takeover.
    await act(async () => {
      release({
        data: {
          status: "ok",
          package: {
            key: "super",
            name: "Super",
            version: 1,
            customized: false,
          },
        } as PackageChangeResponse,
        response: { ok: true },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onTierUpgraded).toHaveBeenCalledTimes(1);
    });
  });

  test("a no_op change-package result dismisses the confirm without the takeover", async () => {
    changePackageImpl = async () => ({
      data: {
        status: "no_op",
        package: { key: "super", name: "Super", version: 1, customized: false },
      },
      response: { ok: true },
    });
    const onTierUpgraded = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      proMightySubscription(),
      plansWithSuper(),
      () => {},
      onTierUpgraded,
    );

    fireEvent.click(await findByTestId("recommended-upgrade-button"));
    fireEvent.click(await findConfirmDialogButton());

    await waitFor(() => {
      if (!changePackageBody) {
        throw new Error("change-package not called");
      }
    });
    // no_op: the sub is already on this package, so the confirm dismisses and
    // the provisioning takeover is never raised.
    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='confirm-package-switch-button']"),
      ).toBeNull();
    });
    expect(onTierUpgraded).not.toHaveBeenCalled();
  });

  test("an unpinned Pro sub's recommended upgrade opens the neutral switch confirm", async () => {
    const onManage = mock(() => {});
    const onTierUpgraded = mock(() => {});
    // An unpinned (Custom) Pro sub is switch-eligible, so the banner CTA reaches
    // the change-package confirm rather than the manage fallback. Its catalog
    // rank is unknown, so the confirm copy stays direction-neutral.
    const subscription: SubscriptionResponse = {
      ...proMightySubscription(),
      package: null,
    };
    const { findByTestId, findByText } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
      onTierUpgraded,
    );

    // The banner renders and its CTA opens the neutral switch confirm (currentKey
    // is null, so the recommended package is Mighty).
    fireEvent.click(await findByTestId("recommended-upgrade-button"));
    await findByText("Switch to Mighty?");
    await findByText(
      "Your plan changes now. Any prorated difference is charged now or credited to your next invoice.",
    );
    expect(onManage).not.toHaveBeenCalled();
    expect(navigateArgs).toEqual([]);
  });

  test("a customized Pro sub's recommended upgrade opens the neutral switch confirm", async () => {
    const onManage = mock(() => {});
    const onTierUpgraded = mock(() => {});
    // A customized pin is switch-eligible; the change-package endpoint re-pins it
    // to the named target. Its catalog rank is ambiguous, so the confirm copy
    // stays direction-neutral instead of claiming an upgrade.
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    const { findByTestId, findByText } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
      onTierUpgraded,
    );

    // Recommended package is Super (next after the customized Mighty pin).
    fireEvent.click(await findByTestId("recommended-upgrade-button"));
    await findByText("Switch to Super?");
    await findByText(
      "Your plan changes now. Any prorated difference is charged now or credited to your next invoice.",
    );
    expect(onManage).not.toHaveBeenCalled();
    expect(navigateArgs).toEqual([]);
  });

  test("a cancelling Pro sub's recommended upgrade stays on the manage path", async () => {
    const onManage = mock(() => {});
    const onTierUpgraded = mock(() => {});
    // A sub pending cancellation 409s on change-package, so the confirm can only
    // fail. The banner CTA must fall back to the manage path.
    const subscription = {
      ...proMightySubscription(),
      cancel_at_period_end: true,
    };
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
      onTierUpgraded,
    );

    fireEvent.click(await findByTestId("recommended-upgrade-button"));

    await waitFor(() => {
      expect(onManage).toHaveBeenCalledTimes(1);
    });
    // No confirm dialog, no change-package mutation, no navigation.
    expect(
      document.querySelector("[data-testid='confirm-package-switch-button']"),
    ).toBeNull();
    expect(changePackageBody).toBeNull();
    expect(onTierUpgraded).not.toHaveBeenCalled();
    expect(navigateArgs).toEqual([]);
    expect(openedUrl).toBeNull();
  });

  test("a non-entitlement-status Pro sub's recommended upgrade stays on the manage path", async () => {
    const onManage = mock(() => {});
    const onTierUpgraded = mock(() => {});
    // A packaged, non-customized, non-cancelling Pro sub in a non-entitlement
    // status (`unpaid`) can't change package — the endpoint 4xxs. The banner CTA
    // must gate on TIER_CHANGE_ELIGIBLE_STATUSES and fall back to the manage path
    // instead of confirming a mutation that can only fail.
    const subscription: SubscriptionResponse = {
      ...proMightySubscription(),
      status: "unpaid",
    };
    const { findByTestId } = renderCardInteractive(
      subscription,
      plansWithSuper(),
      onManage,
      onTierUpgraded,
    );

    fireEvent.click(await findByTestId("recommended-upgrade-button"));

    await waitFor(() => {
      expect(onManage).toHaveBeenCalledTimes(1);
    });
    // No confirm dialog, no change-package mutation, no navigation.
    expect(
      document.querySelector("[data-testid='confirm-package-switch-button']"),
    ).toBeNull();
    expect(changePackageBody).toBeNull();
    expect(onTierUpgraded).not.toHaveBeenCalled();
    expect(navigateArgs).toEqual([]);
    expect(openedUrl).toBeNull();
  });

  test("a base user's recommended upgrade routes to Stripe checkout", async () => {
    const onTierUpgraded = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      baseSubscription(),
      basePlansResponse(),
      () => {},
      onTierUpgraded,
    );

    // No confirm dialog for base users — the CTA starts checkout directly.
    fireEvent.click(await findByTestId("recommended-upgrade-button"));

    await waitFor(() => {
      if (!openedUrl) {
        throw new Error("checkout not opened");
      }
    });
    expect(openedUrl).toBe("https://checkout.example.com/session");
    expect(upgradeCall?.body).toMatchObject({
      target_plan_id: "pro",
      package: "mighty",
      confirm: true,
    });
    // Base users never call change-package or the takeover.
    expect(changePackageBody).toBeNull();
    expect(onTierUpgraded).not.toHaveBeenCalled();
    expect(navigateArgs).toEqual([]);
  });
});
