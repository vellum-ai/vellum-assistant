/**
 * Interaction tests for the PlansPage CTA checkout wiring and the `?package=`
 * deep link.
 *
 * A base subscriber clicking a package button (Power Up / Go Super / Unleash
 * Ultra) fires the Stripe upgrade for THAT package and redirects to the
 * returned checkout URL. An active Pro subscriber switches packages in place
 * (the confirm modal → change-package), and only an *ineligible* Pro sub —
 * cancelling or off an entitlement status — routes to the billing manage modal
 * (`?adjust_plan`), because change-package can only fail for it.
 *
 * The `?package=<key>` deep link reuses that same click handler, so it inherits
 * every guard: it opens the confirm modal for an eligible Pro sub, bails to
 * `?adjust_plan` for an ineligible one, no-ops on the current or an unknown
 * key, never starts a checkout for a non-Pro user, and never treats `free` — a
 * cancellation, not a package — as a switch target. The param is stripped
 * either way and consumed exactly once.
 *
 * The last block covers the ordering between the strip and whatever the handler
 * navigates to. Those are two router navigations, and on the app's route shape
 * the second aborts the first, so it runs on a data router built to match.
 *
 * Strategy mirrors adjust-plan-modal.test.tsx: mock the generated SDK to
 * capture the upgrade body and return a redirect, mock `openUrl` to capture the
 * redirect target, and force the platform-hosted gate open so the page mounts
 * its body instead of firing the not-ready redirect effect.
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
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  useLocation,
} from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as platformGate from "@/hooks/use-platform-gate";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  PlanListResponse,
  ProPlan,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import {
  clearCheckoutIntent,
  readCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";

const CHECKOUT_URL = "https://stripe.test/checkout/session";

type Captured = { body?: unknown };
let upgradeCall: Captured | null = null;
let openedUrl: string | null = null;
// What the two billing reads answer when they are actually fetched. The
// harnesses default them to whatever they seeded into the cache, so a read
// serves the same data the cache holds unless a test deliberately drifts them
// apart to stand for a cache the server has moved past.
let serverSubscription: SubscriptionResponse | null = null;
let serverCatalog: PlanListResponse | null = null;
// When non-null the catalog read rejects with this, standing for a forced
// re-read that fails while the cache it was meant to refresh is still usable.
let catalogReadError: unknown = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({ data: serverSubscription, response: { ok: true } }),
  organizationsBillingPlansRetrieve: () => {
    if (catalogReadError !== null) {
      return Promise.reject(catalogReadError);
    }
    return Promise.resolve({ data: serverCatalog, response: { ok: true } });
  },
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCall = opts;
    return Promise.resolve({
      data: { status: "redirect", checkout_url: CHECKOUT_URL },
      response: { ok: true },
    });
  },
  // PlansPage mounts `useChangeTiers`, which reads onboarding for a Pro sub;
  // resolve it from a fixture so the checkout tests stay hermetic.
  organizationsBillingSubscriptionOnboardingRetrieve: () =>
    Promise.resolve({
      data: {
        max_machine_tier: "medium",
        selected_storage_tier: "xs",
        selected_storage_gib: 10,
      },
      response: { ok: true },
    }),
}));

mock.module("@/runtime/browser", () => ({
  ...browserRuntime,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

// Force the platform-hosted gate open so the page mounts its pricing body
// instead of firing the self-hosted / not-ready redirect effect. Mutable so a
// test can start with hosting unresolved — the state the deep-link effect waits
// through — and flip it to ready mid-test.
let platformHosted = true;
let lifecycleLoading = false;
mock.module("@/hooks/use-platform-gate", () => ({
  ...platformGate,
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => platformHosted,
  useActiveAssistantLifecycleIsLoading: () => lifecycleLoading,
}));

// Render avatar placeholders; skip the lazy compositor bundle in the DOM test.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

const { PlansPage } = await import("./plans-page");

// These tests only need the three catalog keys to exist and render their CTAs,
// so the packages come straight from the shared fixtures.
const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();
const ULTRA = makeUltraPackage();

function fullCatalog(): PlanListResponse {
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
        packages: [MIGHTY, SUPER, ULTRA],
      },
    ],
  };
}

/** A Pro plan with no packages — what the catalog reads with `pro-packages` off. */
function emptyPackagesCatalog(): PlanListResponse {
  const catalog = fullCatalog();
  return {
    plans: catalog.plans.map((plan) => {
      if (plan.id !== "pro") {
        return plan;
      }
      return { ...(plan as ProPlan), packages: [] };
    }),
  };
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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

/**
 * @param subscription seeded into the cache — what the page reads before any
 *   fetch settles.
 * @param options.server what the subscription read answers. Defaults to
 *   `subscription`; a different value stands for a cache the server has already
 *   moved past.
 * @param options.backgroundRefetch mounts on the app's real query defaults
 *   (`staleTime: 0`), so the seeded cache serves the first render while a
 *   refetch runs behind it. The default pins the cache instead, which is the
 *   other shape of the same staleness — a read fresh enough by `staleTime` that
 *   no refetch is scheduled at all.
 * @param options.plans the catalog seeded into the cache.
 * @param options.serverPlans what the catalog read answers. Defaults to
 *   `options.plans`; a different value stands for a cache the server has already
 *   moved past.
 */
function renderPage(
  subscription: SubscriptionResponse,
  entry = "/assistant/plans",
  options: {
    server?: SubscriptionResponse;
    backgroundRefetch?: boolean;
    plans?: PlanListResponse;
    serverPlans?: PlanListResponse;
  } = {},
) {
  serverSubscription = options.server ?? subscription;
  const cachedCatalog = options.plans ?? fullCatalog();
  serverCatalog = options.serverPlans ?? cachedCatalog;
  const client = new QueryClient({
    defaultOptions: {
      queries: options.backgroundRefetch
        ? { retry: false }
        : { retry: false, staleTime: Infinity, refetchOnMount: false },
    },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(
    organizationsBillingPlansRetrieveQueryKey(),
    cachedCatalog,
  );
  return {
    client,
    ...render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={client}>
          <PlansPage />
        </QueryClientProvider>
        <LocationProbe />
      </MemoryRouter>,
    ),
  };
}

/**
 * Data-mode harness that mirrors the app's route shape: `/assistant` carries
 * middleware (`authMiddleware` in `routes.tsx`), and middleware is what keeps
 * React Router off its synchronous no-loader commit path — so a second
 * navigation started in the same tick aborts the first. Declarative
 * `MemoryRouter` cannot reproduce that, which is why the deep-link navigation
 * tests build a data router instead.
 *
 * Returns the ordered list of *committed* locations, which is the observable
 * that distinguishes a strip that landed from one that was thrown away.
 */
function renderRouted(
  subscription: SubscriptionResponse,
  entry: string,
  catalog: PlanListResponse = fullCatalog(),
) {
  serverSubscription = subscription;
  serverCatalog = catalog;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
    },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), catalog);

  const committed: string[] = [];
  const record = (location: { pathname: string; search: string }) => {
    // Emptying the query leaves React Router with a bare "?"; normalize it away
    // so the sequence reads as the URLs a user would see.
    const search = location.search === "?" ? "" : location.search;
    const value = `${location.pathname}${search}`;
    if (committed[committed.length - 1] !== value) {
      committed.push(value);
    }
  };

  const router = createMemoryRouter(
    [
      {
        path: "/assistant",
        middleware: [(_args, next) => next()],
        HydrateFallback: () => null,
        children: [
          { path: "plans", element: <PlansPage /> },
          { path: "settings/usage", element: <div data-testid="usage-page" /> },
        ],
      },
    ],
    { initialEntries: [entry], future: { v8_middleware: true } },
  );
  record(router.state.location);
  router.subscribe((state) => record(state.location));

  return {
    client,
    committed,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  upgradeCall = null;
  openedUrl = null;
  platformHosted = true;
  lifecycleLoading = false;
  serverSubscription = null;
  serverCatalog = null;
  catalogReadError = null;
  // The stash also keeps an in-memory mirror, so clearing sessionStorage alone
  // leaves a prior test's intent readable.
  clearCheckoutIntent();
});

afterEach(() => {
  cleanup();
});

describe("PlansPage checkout — base subscriber", () => {
  const cases = [
    { label: "Power Up", pkg: "mighty" },
    { label: "Go Super", pkg: "super" },
    { label: "Unleash Ultra", pkg: "ultra" },
  ];

  for (const { label, pkg } of cases) {
    test(`"${label}" starts Stripe checkout for the ${pkg} package`, async () => {
      const { getByRole } = renderPage(freeSubscription());

      fireEvent.click(getByRole("button", { name: label }));

      await waitFor(() => expect(upgradeCall).not.toBeNull());
      expect(upgradeCall!.body).toEqual({
        target_plan_id: "pro",
        package: pkg,
        confirm: true,
        // Off Electron the web return URL is kept — a browser can't open
        // the `vellum://` bounce the native return relies on.
        return_target: "web",
      });
      await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
      expect(readCheckoutIntent()).toMatchObject({
        kind: "package",
        packageKey: pkg,
      });
    });
  }
});

describe("PlansPage checkout — Pro subscriber", () => {
  // Below Mighty, Base reads "Downgrade to Base". Downgrading a Pro org to the
  // Free plan is a subscription cancellation, not a package switch — clicking it
  // opens a confirm step (then the Stripe billing portal, the same destination
  // as the adjust-plan modal's "Downgrade to Base"). The full confirm → portal
  // flow is covered in `plans-page.test.tsx`; here we only guard that it never
  // fires a Stripe checkout. This harness seeds the cache without mocking the
  // read endpoints, so the confirm/portal/location aren't asserted.
  test("a Free downgrade CTA never starts a Stripe checkout", () => {
    const { getByRole } = renderPage(proMightySubscription());

    fireEvent.click(getByRole("button", { name: "Downgrade to Base" }));

    expect(upgradeCall).toBeNull();
    expect(readCheckoutIntent()).toBeNull();
  });
});

// `?package=<key>` is the URL entry into the in-place package switch — the
// funnel marketing's upgrade CTAs and the checkout no-op bail land on. It calls
// the same handler a card click does, so every assertion below is really about
// a guard being inherited rather than re-implemented.
describe("PlansPage — ?package= deep link", () => {
  // Emptying the query leaves React Router with a bare "?" on the path, so the
  // assertion is on the param being gone rather than an exact string.
  const ON_PLANS_WITHOUT_PARAM = /^\/assistant\/plans\??$/;

  test("an eligible Pro sub opens the switch confirm for the requested package", async () => {
    const { findByText, getByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=super",
    );

    // The confirm modal — not a checkout, not a direct change-package.
    await findByText("Upgrade to Super");
    expect(upgradeCall).toBeNull();
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
  });

  test("an ineligible Pro sub bails to the billing manage surface", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      { ...proMightySubscription(), cancel_at_period_end: true },
      "/assistant/plans?package=super",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(
        "/assistant/settings/usage?tab=billing&adjust_plan",
      ),
    );
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("the current package is a no-op", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=mighty",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("an unknown package key is a no-op", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=bogus",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("a non-Pro sub starts no checkout, and the param is still dropped", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      freeSubscription(),
      "/assistant/plans?package=super",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    // A URL alone must never charge anyone: the base user still has to press
    // the card's CTA.
    expect(upgradeCall).toBeNull();
    expect(readCheckoutIntent()).toBeNull();
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
  });

  test("`free` names a cancellation, not a package — it never opens the confirm", async () => {
    const { getByTestId, queryAllByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=free",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    expect(queryAllByTestId("confirm-free-downgrade-button").length).toBe(0);
    expect(queryAllByTestId("confirm-package-switch-button").length).toBe(0);
    expect(upgradeCall).toBeNull();
  });

  // The link is spent the first time it is acted on, so it has to be acted on
  // against what the server says now. The checkout `no_op` bail is the case
  // that makes this load-bearing: it routes here *because* the account is
  // already Pro, which is precisely when a subscription cached from before the
  // upgrade still reads Base.
  test("a cached Base read can't consume the link while a refetch is in flight", async () => {
    const { findByText, getByTestId } = renderPage(
      freeSubscription(),
      "/assistant/plans?package=super",
      { server: proMightySubscription(), backgroundRefetch: true },
    );

    await findByText("Upgrade to Super");
    expect(upgradeCall).toBeNull();
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
  });

  test("a cached Base read can't consume the link when no refetch is scheduled", async () => {
    const { findByText, getByTestId } = renderPage(
      freeSubscription(),
      "/assistant/plans?package=super",
      { server: proMightySubscription() },
    );

    await findByText("Upgrade to Super");
    expect(upgradeCall).toBeNull();
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
  });

  // The catalog carries the same staleness as the subscription. A read taken
  // with `pro-packages` off answers an empty package list, and emptiness is what
  // the page treats as nothing-to-show — so the cached verdict has to wait for
  // the forced re-read rather than bounce the link first.
  test("a cached empty catalog can't bail the link before the forced re-read lands", async () => {
    const { findByText, getByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=super",
      { plans: emptyPackagesCatalog(), serverPlans: fullCatalog() },
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    await findByText("Upgrade to Super");
    expect(upgradeCall).toBeNull();
  });

  // A forced re-read that fails is still a finished read: the cache it was meant
  // to refresh is right there, so the link decides from that instead of sitting
  // unconsumed with no modal, no redirect, and the param still on the URL.
  test("a failed forced catalog re-read decides from the retained cache", async () => {
    catalogReadError = new Error("catalog read failed");
    const { findByText, getByTestId, queryByLabelText } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=super",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    await findByText("Upgrade to Super");
    expect(queryByLabelText("Loading plans")).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  // No amount of re-reading billing turns a self-hosted assistant into a hosted
  // one, so that bail must not be held behind the deep link's forced reads. It
  // also lands on the plain billing page — there is no adjust-plan upgrade path
  // without a platform session.
  test("self-hosted still bails immediately with the link present", async () => {
    platformHosted = false;
    const { getByTestId, queryAllByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=super",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(
        "/assistant/settings/usage?tab=billing",
      ),
    );
    expect(queryAllByTestId("confirm-package-switch-button").length).toBe(0);
    expect(upgradeCall).toBeNull();
  });

  test("the param is consumed once — later subscription changes don't reopen the modal", async () => {
    // Hold the effect on unresolved hosting so the param survives the first
    // render; flipping hosting ready is then a real dep change that drives the
    // one and only consume.
    platformHosted = false;
    lifecycleLoading = true;
    const { client, findByText, findByRole, getByTestId, queryAllByTestId } =
      renderPage(proMightySubscription(), "/assistant/plans?package=super");

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(
        "/assistant/plans?package=super",
      ),
    );
    expect(queryAllByTestId("confirm-package-switch-button").length).toBe(0);

    act(() => {
      platformHosted = true;
      lifecycleLoading = false;
      // Wakes the subscribed component so the hooks re-read the gate. The
      // payload has to differ structurally: React Query's structural sharing
      // keeps the previous reference for a deep-equal one, and no reference
      // change means no re-render.
      client.setQueryData(organizationsBillingSubscriptionRetrieveQueryKey(), {
        ...proMightySubscription(),
        current_period_end: "2026-08-10T00:00:00Z",
      });
    });

    await findByText("Upgrade to Super");
    fireEvent.click(await findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(queryAllByTestId("confirm-package-switch-button").length).toBe(0),
    );

    // `isProUser` is a dependency of the deep-link effect, so dropping to Free
    // and back to Pro genuinely re-runs it — twice. What keeps the modal closed
    // is the consumed-param guard, not React skipping the effect.
    act(() => {
      client.setQueryData(
        organizationsBillingSubscriptionRetrieveQueryKey(),
        freeSubscription(),
      );
    });
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    act(() => {
      client.setQueryData(
        organizationsBillingSubscriptionRetrieveQueryKey(),
        proMightySubscription(),
      );
    });

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    expect(queryAllByTestId("confirm-package-switch-button").length).toBe(0);
    expect(upgradeCall).toBeNull();
  });
});

// The param strip and anything `selectTier` navigates to are both router
// navigations. Starting the second while the first is still pending aborts it,
// and with middleware on the route tree the first is *always* still pending —
// so these run on a data router shaped like the app's.
describe("PlansPage — ?package= deep link navigation", () => {
  test("the strip commits before the ineligible-Pro bail", async () => {
    const { committed, router } = renderRouted(
      { ...proMightySubscription(), cancel_at_period_end: true },
      "/assistant/plans?package=super",
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/assistant/settings/usage"),
    );
    expect(committed).toEqual([
      "/assistant/plans?package=super",
      "/assistant/plans",
      "/assistant/settings/usage?tab=billing&adjust_plan",
    ]);

    // Back must never land on the deep link: that entry re-fires the effect and
    // pushes the user straight out again, with no way onto the plans page.
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.search).not.toContain("package=");
  });

  test("the strip does not abort the catalog-empty bail", async () => {
    const { router } = renderRouted(
      proMightySubscription(),
      "/assistant/plans?package=super",
      emptyPackagesCatalog(),
    );

    await waitFor(() =>
      expect(
        `${router.state.location.pathname}${router.state.location.search}`,
      ).toBe("/assistant/settings/usage?tab=billing&adjust_plan"),
    );
  });
});
