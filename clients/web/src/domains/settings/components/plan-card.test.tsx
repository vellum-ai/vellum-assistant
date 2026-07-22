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
  data: { status: "ok" } as PackageChangeResponse,
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

/** Waits for the ConfirmDialog (portaled to document.body) to open. */
async function findConfirmDialogButton(): Promise<HTMLButtonElement> {
  return await waitFor(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      "[data-confirm-dialog-confirm]",
    );
    if (!btn) throw new Error("confirm dialog not open");
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
    data: { status: "ok" } as PackageChangeResponse,
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
    expect(html).toContain("plan-card-renews");
    expect(html).toContain("auto renew");
  });

  test("shows the upgrade button for a base plan", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-card-upgrade-button");
    expect(html).toContain("View Plans");
  });

  test("does not render the invoices button (moved to inline table)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).not.toContain("plan-card-invoices-button");
  });

  test("renders the recommended-upgrade banner (Mighty from Free)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Recommended Upgrade");
    expect(html).toContain("Mighty");
  });

  test("no upgrade banner when the package catalog is empty (flag off)", () => {
    const html = renderCard(baseSubscription(), emptyCatalogPlans());
    expect(html).not.toContain("recommended-upgrade-button");
    expect(html).not.toContain("Recommended Upgrade");
  });

  test("Free → Mighty chips: credits, storage, and the larger-machines unlock", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    // Mighty keeps the small baseline machine (machine_size null), so the third
    // chip advertises the Pro larger-machines unlock rather than a no-op
    // "Small Machine" row. The vCPU chip is gone entirely.
    expect(html).toContain("Larger machines");
    expect(html).not.toContain("vCPU");
    expect(html).not.toContain("Small Machine");
    expect(html).not.toContain("Standard");
    // Credits step from Free's $0 to Mighty's $25 (arrow form, real change),
    // labelled per-month.
    expect(html).toContain("$0 → $25 credits/mo");
    // Storage really changes (free's 4 GiB baseline → Mighty's 10 GB).
    expect(html).toContain("4 → 10 GB");
    expect(html).not.toContain("0 → 10 GB");
  });

  test("Mighty → Super: recommends Super with a machine step-up chip", () => {
    const html = renderCard(proMightySubscription(), plansWithSuper());
    // On Mighty, the recommended upgrade is the next catalog package, Super.
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Recommended Upgrade");
    expect(html).toContain("Super");
    // The machine tier actually changes here, so the third chip is the machine
    // arrow — NOT the larger-machines unlock (that's only the Free → Pro step).
    expect(html).toContain("Small → Medium Machine");
    expect(html).not.toContain("Larger machines");
    // Credits and storage step up from Mighty's values.
    expect(html).toContain("$25 → $45 credits/mo");
    expect(html).toContain("10 → 30 GB");
    // The current-plan row shows the actual package name "Mighty" (not the
    // generic plan name "Pro").
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Mighty");
    expect(html).not.toContain("Pro");
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
    // A plan whose tiers diverged from the pinned package reads "Mighty
    // (Custom)" so it doesn't masquerade as the stock package.
    expect(html).toContain("Mighty (Custom)");
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

  test("a Pro sub without a pinned package stays on onManage", async () => {
    const onManage = mock(() => {});
    // A legacy/custom Pro sub (no package) would render as free in the takeover,
    // so it stays on the manage modal even with a live catalog.
    const subscription = { ...proMightySubscription(), package: undefined };
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

    // The banner CTA opens a confirm dialog (no immediate mutation).
    fireEvent.click(await findByTestId("recommended-upgrade-button"));
    await findByText("You'll be charged the prorated difference now.");
    expect(changePackageBody).toBeNull();

    // Confirming posts the recommended package key to change-package.
    fireEvent.click(await findConfirmDialogButton());

    await waitFor(() => {
      if (!changePackageBody) throw new Error("change-package not called");
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
        "[data-confirm-dialog-confirm]",
      );
      if (!confirm?.disabled) throw new Error("confirm not disabled yet");
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
          package: { key: "super", name: "Super", version: 1, customized: false },
        } as PackageChangeResponse,
        response: { ok: true },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onTierUpgraded).toHaveBeenCalledTimes(1);
    });
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
      if (!openedUrl) throw new Error("checkout not opened");
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
