/**
 * Tests for the PlanCard: verifies the plan name, renewal text, the header's
 * "View All Plans" button, and the side-by-side current / next plan tiles
 * render correctly, plus the header button's navigation wiring. The card shows
 * no credit bundle label and no invoices button; invoices render in an inline
 * table on the billing page.
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
  within,
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
import * as toastModule from "@vellumai/design-library/components/toast";
import { UPGRADE_CAPTION } from "@/domains/settings/billing/plans/package-switch-copy";
import { PLAN_TIER_COPY } from "@/domains/settings/billing/plans/plans-copy";
import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import * as takeoverAvatarStash from "@/lib/billing/takeover-avatar-stash";
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
}));

// Stub the toaster: the no_op change-package branch toasts, and no <Toaster />
// is mounted in these tests.
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: Object.assign((..._args: unknown[]) => {}, {
    success: () => {},
    error: () => {},
    info: () => {},
    warning: () => {},
  }),
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

// Count the avatar snapshot the checkout redirect takes; the real capture reads
// the resolved-assistants store, which these DOM tests never drive.
let captureStashCalls = 0;
mock.module("@/lib/billing/takeover-avatar-stash", () => ({
  ...takeoverAvatarStash,
  captureTakeoverAvatarStash: () => {
    captureStashCalls += 1;
  },
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
        packages: [makeProPackage()],
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
    pro.packages.push(makeSuperPackage());
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

/** Catalog with Mighty, Super, and Ultra — so Ultra is the top package. */
function plansWithUltra(): PlanListResponse {
  const plans = plansWithSuper();
  const pro = plans.plans.find((p) => p.id === "pro");
  if (pro && "packages" in pro && pro.packages) {
    pro.packages.push(makeUltraPackage());
  }
  return plans;
}

/** A subscriber cleanly pinned to the top (Ultra) Pro package. */
function proUltraSubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_end: "2026-08-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "ultra", name: "Ultra", version: 1, customized: false },
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

/**
 * The static markup parsed into a detached DOM node, so an assertion can be
 * scoped to one tile. Both tiles render spec chips, so a whole-document text
 * match cannot tell the current tile's chips from the next tile's.
 */
function renderCardDom(
  subscription: SubscriptionResponse,
  plans: PlanListResponse,
): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderCard(subscription, plans);
  return host;
}

/** The current-plan tile, which inherits the app theme. */
function currentTile(host: HTMLElement): HTMLElement {
  const tile = host.querySelector<HTMLElement>(
    '[data-testid="plan-tile-current"]',
  );
  if (!tile) {
    throw new Error("expected a current-plan tile");
  }
  return tile;
}

/** The next-plan tile, whose nested scope inverts the app theme. */
function nextTile(host: HTMLElement): HTMLElement {
  const tile = host.querySelector<HTMLElement>(
    '[data-testid="plan-tile-next"]',
  );
  if (!tile) {
    throw new Error("expected a next-plan tile");
  }
  return tile;
}

/** `freePlanSpecs` / `packageSpecs` chip labels for each fixture plan. */
const FREE_CHIPS = ["Small Machine", "4 GB Storage", "Pay as you go credits"];
const MIGHTY_CHIPS = [
  "Small Machine",
  "10 GB Storage",
  "$25 in credits included",
];
const SUPER_CHIPS = [
  "Medium Machine",
  "30 GB Storage",
  "$45 in credits included",
  "Assistant email and subdomain",
];

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
  captureStashCalls = 0;
});

afterEach(() => {
  cleanup();
});

describe("PlanCard", () => {
  test("shows the plan name and renewal text for a base plan", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Free");
    expect(html).toContain("Current");
    expect(html).toContain("plan-card-renews");
    expect(html).toContain("auto renew");
  });

  test("shows the plans button for a base plan", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-card-plans-button");
    expect(html).toContain("View All Plans");
  });

  test("does not render the invoices button (moved to inline table)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).not.toContain("plan-card-invoices-button");
  });

  test("renders the next-plan tile (Mighty from Free)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-tile-next");
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Next Plan");
    // The tile names the package alone, and its CTA quotes the delta from the
    // free baseline (Mighty is $30/month).
    expect(html).toContain("Power Up for +$30/month");
    expect(html).not.toContain("Upgrade to Mighty");
    expect(html).not.toContain("Recommended");
  });

  test("no next tile when the package catalog is empty (flag off)", () => {
    const html = renderCard(baseSubscription(), emptyCatalogPlans());
    // Only the current tile renders; the next tile (and its CTA) is gone.
    expect(html).toContain("plan-tile-current");
    expect(html).not.toContain("plan-tile-next");
    expect(html).not.toContain("recommended-upgrade-button");
  });

  test("Free current tile shows the free chips and price; next tile shows Mighty's", () => {
    const host = renderCardDom(baseSubscription(), basePlansResponse());
    // The current (Free) tile carries the free baseline chips, the "Current"
    // tag, and a "Free Forever" price footer.
    const current = within(currentTile(host));
    for (const label of FREE_CHIPS) {
      expect(current.getByText(label)).toBeTruthy();
    }
    expect(current.getByText("Current")).toBeTruthy();
    expect(current.getByTestId("plan-card-price").textContent).toBe(
      "Free Forever",
    );
    // The next (Mighty) tile names the package, tags it "Next Plan", and shows
    // the package's spec chips above its CTA instead of a price footer.
    const next = within(nextTile(host));
    expect(next.getByText("Mighty")).toBeTruthy();
    expect(next.getByText("Next Plan")).toBeTruthy();
    for (const label of MIGHTY_CHIPS) {
      expect(next.getByText(label)).toBeTruthy();
    }
    expect(next.queryByTestId("plan-card-price")).toBeNull();
    expect(host.innerHTML).not.toContain("Recommended");
  });

  test("the next tile inverts the app theme; the current tile inherits it", () => {
    // The static render snapshots the document theme as "light", so the next
    // tile scopes itself to "dark" while the current tile forces nothing.
    const host = renderCardDom(baseSubscription(), basePlansResponse());
    expect(nextTile(host).getAttribute("data-theme")).toBe("dark");
    expect(currentTile(host).hasAttribute("data-theme")).toBe(false);
  });

  test("Mighty → Super: current tile keeps its chips, next tile shows Super's", () => {
    const host = renderCardDom(proMightySubscription(), plansWithSuper());
    // On Mighty, the next package up is Super, priced $70/month above it.
    const next = within(nextTile(host));
    expect(next.getByText("Super")).toBeTruthy();
    expect(next.getByText("Next Plan")).toBeTruthy();
    for (const label of SUPER_CHIPS) {
      expect(next.getByText(label)).toBeTruthy();
    }
    expect(
      next.getByTestId("recommended-upgrade-button").textContent,
    ).toContain("Power Up for +$70/month");
    expect(host.innerHTML).not.toContain("Recommended");
    // The current (Mighty) tile keeps its own absolute chips and price, and
    // names the actual package ("Mighty"), not the generic plan name "Pro".
    const current = within(currentTile(host));
    for (const label of MIGHTY_CHIPS) {
      expect(current.getByText(label)).toBeTruthy();
    }
    expect(current.getByTestId("plan-card-name").textContent).toBe("Mighty");
    expect(current.getByTestId("plan-card-price").textContent).toBe(
      "$30/month",
    );
  });

  test("an unpinned Custom sub renders no next tile", () => {
    // A legacy unpinned Pro sub's real tiers can diverge from any stock
    // package, so it gets no next tile to step up to; the plans takeover owns
    // that switch. Its own tile shows no chips and no price either.
    const subscription: SubscriptionResponse = {
      ...proMightySubscription(),
      package: null,
    };
    const html = renderCard(subscription, plansWithSuper());
    expect(html).not.toContain("plan-tile-next");
    expect(html).not.toContain("recommended-upgrade-button");
    expect(html).not.toContain("Next Plan");
    expect(html).not.toContain("plan-card-price");
    expect(html).not.toContain("Small Machine");
  });

  test("a customized Pro sub renders no next tile", () => {
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    const html = renderCard(subscription, plansWithSuper());
    // A customized pin's tiers can differ from stock, so a stock delta could
    // misstate the change: no next tile, no chips, and no price.
    expect(html).not.toContain("plan-tile-next");
    expect(html).not.toContain("recommended-upgrade-button");
    expect(html).not.toContain("Next Plan");
    expect(html).not.toContain("plan-card-price");
  });

  test("a top-of-catalog (Ultra) clean pin renders no next tile", () => {
    // Ultra is the highest catalog package, so there is nothing to step up to.
    const html = renderCard(proUltraSubscription(), plansWithUltra());
    expect(html).not.toContain("plan-tile-next");
    expect(html).not.toContain("recommended-upgrade-button");
    // Its own tile still carries the package's chips and price.
    expect(html).toContain("plan-card-price");
    expect(html).toContain("$200/month");
    expect(html).toContain("Large Machine");
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
  });

  test("a clean-pinned Pro sub whose package is absent from the catalog shows no chips", () => {
    // A clean pin on Mighty, but the catalog has no packages (e.g. the
    // `pro-packages` flag is off, or the pinned key isn't in this response). The
    // package lookup misses, so the current tile's specs are unknowable and it
    // must render NO chips and NO price. Crucially not the free baseline,
    // which would mislabel this paid Pro sub as a 4 GB pay-as-you-go plan.
    const html = renderCard(proMightySubscription(), emptyCatalogPlans());
    // The current tile still names the pinned package ("Mighty"), not "Custom".
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Mighty");
    // No free-baseline chips leak onto the paid sub's current tile.
    for (const label of FREE_CHIPS) {
      expect(html).not.toContain(label);
    }
    expect(html).not.toContain("plan-card-price");
  });

  test("a clean pin on an older package version shows no chips or price", () => {
    // The org is pinned to Mighty v1 while the live catalog carries v2. The
    // pinned version's price and specs are grandfathered, so the catalog entry
    // must not describe this sub: no chips, no price, and a delta-less CTA.
    const plans = plansWithSuper();
    const pro = plans.plans.find((p) => p.id === "pro");
    if (pro && "packages" in pro && pro.packages) {
      pro.packages = pro.packages.map((p) => ({ ...p, version: 2 }));
    }
    const host = renderCardDom(proMightySubscription(), plans);
    // The current tile still names the pinned package.
    const current = within(currentTile(host));
    expect(current.getByTestId("plan-card-name").textContent).toBe("Mighty");
    for (const label of MIGHTY_CHIPS) {
      expect(current.queryByText(label)).toBeNull();
    }
    expect(current.queryByTestId("plan-card-price")).toBeNull();
    // Super is still the next package up, but its CTA quotes no delta.
    const next = within(nextTile(host));
    expect(next.getByText("Super")).toBeTruthy();
    expect(next.getByTestId("recommended-upgrade-button").textContent).toBe(
      "Power Up",
    );
  });
});

describe("PlanCard action button", () => {
  test("a Pro user's View All Plans click opens the plan-aware takeover", async () => {
    const onManage = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      proMightySubscription(),
      plansWithSuper(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-plans-button"));

    // navigate() fires from the click handler; await it so the assertion never
    // races the handler's commit in the CI runner.
    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("a base user's View All Plans click opens the plans takeover", async () => {
    const onManage = mock(() => {});
    const { findByTestId } = renderCardInteractive(
      baseSubscription(),
      basePlansResponse(),
      onManage,
    );

    fireEvent.click(await findByTestId("plan-card-plans-button"));

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

    fireEvent.click(await findByTestId("plan-card-plans-button"));

    // The empty catalog wires the button to onManage; await it so the assertion
    // never races the handler's commit in the CI runner.
    await waitFor(() => {
      expect(onManage).toHaveBeenCalledTimes(1);
    });
    expect(navigateArgs).toEqual([]);
  });

  test("a customized Pro sub's View All Plans opens the plans takeover", async () => {
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

    fireEvent.click(await findByTestId("plan-card-plans-button"));

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

    fireEvent.click(await findByTestId("plan-card-plans-button"));

    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("a from-scratch custom Pro sub's View All Plans opens the takeover", async () => {
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

    fireEvent.click(await findByTestId("plan-card-plans-button"));

    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("a cancelling custom Pro sub's View All Plans stays on the fallback", async () => {
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

    fireEvent.click(await findByTestId("plan-card-plans-button"));

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

    fireEvent.click(await findByTestId("plan-card-plans-button"));

    await waitFor(() => {
      expect(navigateArgs).toEqual([[routes.plans, undefined]]);
    });
    expect(onManage).not.toHaveBeenCalled();
  });

  test("an unpaid custom Pro sub's View All Plans stays on the fallback", async () => {
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

    fireEvent.click(await findByTestId("plan-card-plans-button"));

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

    // The next tile's CTA opens a confirm dialog (no immediate mutation). A
    // clean pin keeps the directional upgrade copy.
    fireEvent.click(await findByTestId("recommended-upgrade-button"));
    // Assert on copy unique to the dialog. The next tile behind it already
    // names Super, so the dialog title alone would match twice.
    await findByText(UPGRADE_CAPTION);
    await findByText(PLAN_TIER_COPY.super.tagline);
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

    // In-flight: the confirm button and the next tile's CTA both disable.
    await waitFor(() => {
      const confirm = document.querySelector<HTMLButtonElement>(
        "[data-testid='confirm-package-switch-button']",
      );
      if (!confirm?.disabled) {
        throw new Error("confirm not disabled yet");
      }
    });
    const nextCta = (await findByTestId(
      "recommended-upgrade-button",
    )) as HTMLButtonElement;
    expect(nextCta.disabled).toBe(true);

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

  test("a cancelling Pro sub's recommended upgrade stays on the manage path", async () => {
    const onManage = mock(() => {});
    const onTierUpgraded = mock(() => {});
    // A sub pending cancellation 409s on change-package, so the confirm can only
    // fail. The next tile's CTA must fall back to the manage path.
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
    // status (`unpaid`) can't change package: the endpoint 4xxs. The next
    // tile's CTA must gate on TIER_CHANGE_ELIGIBLE_STATUSES and fall back to
    // the manage path instead of confirming a mutation that can only fail.
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
    // The redirect snapshots the avatar so the takeover can draw it on return.
    expect(captureStashCalls).toBe(1);
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
