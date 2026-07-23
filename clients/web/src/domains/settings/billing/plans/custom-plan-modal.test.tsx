/**
 * Interaction tests for the Custom Plan configurator modal.
 *
 * A base subscriber clicking Configure gets the "Create a custom plan" modal;
 * Continue stays disabled until all three dropdowns (machine size, storage,
 * credits) have an explicit choice, then fires the Stripe upgrade with the
 * selected tiers. An eligible Pro subscriber reaches the same modal seeded to
 * its current tiers, and Continue dispatches the change-machine/storage/
 * credit-tier endpoints (not checkout, which no-ops for an active Pro sub) and
 * opens the resize takeover. Configure opens the modal for a Pro sub the
 * catalog can't fully represent too — e.g. a deprecated credit bundle — with
 * the seed holding the tier and any un-representable apply surfacing as a toast.
 *
 * Strategy mirrors plans-page-checkout.test.tsx: mock the generated SDK to
 * capture the request bodies and return fixtures, mock `openUrl` to capture
 * the redirect target, and force the platform-hosted gate open. The
 * design-library Dropdown is a custom combobox — driven by clicking the
 * trigger, then the option whose visible label matches.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as platformGate from "@/hooks/use-platform-gate";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  OnboardingStateResponse,
  PlanListResponse,
  ProPackage,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

const CHECKOUT_URL = "https://stripe.test/checkout/session";

type Captured = { body?: unknown };
let upgradeCall: Captured | null = null;
let machineTierCall: Captured | null = null;
let storageTierCall: Captured | null = null;
let creditTierCall: Captured | null = null;
let openedUrl: string | null = null;
// When non-null, the change-machine-tier call rejects with this — drives the
// error path (the hook toasts and the caller keeps the modal open).
let machineTierError: unknown = null;
// Read fixtures returned by the mocked SDK so post-mutation invalidation
// refetches resolve deterministically instead of hitting the network.
let subscriptionFixture: SubscriptionResponse | null = null;
let plansFixture: PlanListResponse | null = null;
let onboardingFixture: OnboardingStateResponse | null = null;
// When true, the onboarding fetch never resolves — models the first load still
// in flight so the Configure CTA's loading gate can be exercised.
let onboardingHangs = false;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCall = opts;
    return Promise.resolve({
      data: { status: "redirect", checkout_url: CHECKOUT_URL },
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
  organizationsBillingSubscriptionOnboardingRetrieve: () =>
    onboardingHangs
      ? new Promise(() => {})
      : Promise.resolve({ data: onboardingFixture, response: { ok: true } }),
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
  ...platformGate,
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

// Render avatar placeholders; skip the lazy compositor bundle in the DOM test.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

// Stand in for the provisioning takeover so a Pro tier change can assert it was
// revealed in resize mode without driving its own provisioning polls. The full
// loading → "You're all set!" flow is owned by
// billing-onboarding-modal.test.tsx's resize-mode suite.
mock.module(
  "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal",
  () => ({
    BillingOnboardingModal: ({
      open,
      mode,
    }: {
      open: boolean;
      mode?: string;
    }) =>
      open ? (
        <div data-testid="resize-takeover" data-mode={mode ?? "checkout"} />
      ) : null,
  }),
);

const { PlansPage } = await import("./plans-page");

const MIGHTY: ProPackage = {
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
};

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
          {
            tier: "xl",
            label: "250 GB",
            storage_gib: 250,
            price_cents: 6000,
            lookup_key: "storage_250",
            legacy: true,
          },
        ],
        credit_tiers: [
          {
            tier: "credits_50",
            label: "50 credits",
            credits_usd: 50,
            price_cents: 5000,
            lookup_key: "credits_50",
          },
        ],
        packages: [MIGHTY],
      },
    ],
  };
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

function proMightySubscription(
  overrides: Partial<SubscriptionResponse> = {},
): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_end: "2026-07-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    selected_credit_tier: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
    ...overrides,
  };
}

/** Onboarding state carrying the Pro sub's current machine/storage tiers. */
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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderPage(
  subscription: SubscriptionResponse,
  onboardingData: OnboardingStateResponse = onboarding(),
  { seedOnboarding = true }: { seedOnboarding?: boolean } = {},
) {
  subscriptionFixture = subscription;
  plansFixture = fullCatalog();
  onboardingFixture = onboardingData;
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
  client.setQueryData(
    organizationsBillingPlansRetrieveQueryKey(),
    fullCatalog(),
  );
  if (seedOnboarding) {
    client.setQueryData(
      organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      onboardingData,
    );
  }
  return render(
    <MemoryRouter initialEntries={["/assistant/plans"]}>
      <QueryClientProvider client={client}>
        <PlansPage />
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function dropdownTrigger(ariaLabel: string): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${ariaLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a "${ariaLabel}" dropdown trigger`);
  }
  return trigger;
}

function openDropdown(ariaLabel: string): void {
  fireEvent.click(dropdownTrigger(ariaLabel));
}

function optionLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

/** Clicks the open-menu option whose text starts with `label` (options may
 * carry a "+$N/mo" price suffix after the label). */
function clickOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => (o.textContent?.trim() ?? "").startsWith(label));
  if (!option) {
    throw new Error(
      `expected option "${label}" — saw: ${optionLabels()
        .map((l) => `"${l}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

function selectOption(dropdownLabel: string, optionLabel: string): void {
  openDropdown(dropdownLabel);
  clickOption(optionLabel);
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

beforeEach(() => {
  upgradeCall = null;
  machineTierCall = null;
  storageTierCall = null;
  creditTierCall = null;
  openedUrl = null;
  machineTierError = null;
  onboardingHangs = false;
  subscriptionFixture = null;
  plansFixture = null;
  onboardingFixture = null;
});

afterEach(() => {
  cleanup();
});

/** Finds an open-menu option element whose text starts with `label`. */
function findOption(label: string): HTMLElement {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => (o.textContent?.trim() ?? "").startsWith(label));
  if (!option) {
    throw new Error(`expected option "${label}"`);
  }
  return option;
}

/** The recap's "…compared to previous (…)" delta span, or null when absent. */
function deltaLine(): HTMLElement | null {
  const dialog = document.querySelector('[role="dialog"]');
  return (
    Array.from(dialog?.querySelectorAll<HTMLElement>("span") ?? []).find((s) =>
      (s.textContent ?? "").includes("compared to previous"),
    ) ?? null
  );
}

/** The recap's `<li>` texts (each row's full concatenated text). Only valid
 * with the dropdown menus closed — their options render as `li` too. */
function recapRows(): string[] {
  const dialog = document.querySelector('[role="dialog"]');
  return Array.from(dialog?.querySelectorAll("li") ?? []).map(
    (li) => li.textContent?.trim() ?? "",
  );
}

/** Struck-through (previous-value) recap labels. */
function strikethroughs(): string[] {
  const dialog = document.querySelector('[role="dialog"]');
  return Array.from(dialog?.querySelectorAll("s.line-through") ?? []).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

/** Each recap row's check-icon classes, in row order. */
function checkIconClasses(): string[] {
  const dialog = document.querySelector('[role="dialog"]');
  return Array.from(dialog?.querySelectorAll("li") ?? []).map(
    (li) =>
      li.querySelector("div:last-child > svg")?.getAttribute("class") ?? "",
  );
}

describe("CustomPlanModal — base subscriber", () => {
  test("Continue stays disabled until every dropdown has a choice", () => {
    const { getByRole, getByText } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));
    getByText("Create a custom plan");

    expect(continueButton().disabled).toBe(true);

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    expect(continueButton().disabled).toBe(true);

    selectOption("Storage", "30 GB");
    expect(continueButton().disabled).toBe(true);

    selectOption("Credit bundle", "No extra credits");
    expect(continueButton().disabled).toBe(false);
  });

  test("legacy storage tiers are not offered", () => {
    const { getByRole } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));
    openDropdown("Storage");

    const labels = optionLabels();
    expect(labels.some((l) => l.startsWith("30 GB"))).toBe(true);
    expect(labels.some((l) => l.startsWith("250 GB"))).toBe(false);
  });

  test("recap opens with just the labeled base fee", () => {
    const { getByRole, getByText } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    // Nothing selected yet — the total is the bare base fee, and the recap's
    // permanent first row labels where it comes from.
    getByText("$20/mo");
    getByText("Pro base plan — $20/mo");
  });

  test("recap totals the base price plus the selected tiers", () => {
    const { getByRole, getByText } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    selectOption("Storage", "30 GB");
    selectOption("Credit bundle", "50 credits");

    // $20 base + $60 machine + $10 storage + $50 credits.
    getByText("$140/mo");

    // Read the recap rows rather than getByText — the machine text also appears
    // in its dropdown trigger and would double-match.
    expect(recapRows()).toEqual([
      "Pro base plan — $20/mo",
      "Large machine (4 vCPU, 8 GiB)",
      "30 GB storage",
      "$50 of bundled credits",
    ]);
  });

  test("base checkout shows no delta line and no strikethrough", () => {
    // No seed (a base subscriber), so there is no previous plan to compare
    // against — the recap stays the plain grey-check list.
    const { getByRole } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    selectOption("Storage", "30 GB");
    selectOption("Credit bundle", "50 credits");

    expect(deltaLine()).toBeNull();
    expect(strikethroughs()).toEqual([]);
  });

  test("Continue starts a Stripe checkout with the selected tiers", async () => {
    const { getByRole } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    selectOption("Storage", "30 GB");
    selectOption("Credit bundle", "No extra credits");
    fireEvent.click(continueButton());

    await waitFor(() => expect(upgradeCall).not.toBeNull());
    expect(upgradeCall!.body).toEqual({
      target_plan_id: "pro",
      confirm: true,
      machine_tier: "large",
      storage_tier: "s",
      credit_tier: null,
      // Off Electron the web return URL is kept — a browser can't open
      // the `vellum://` bounce the native return relies on.
      return_target: "web",
    });
    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
  });

  test("Cancel closes the modal without a checkout", () => {
    const { getByRole, queryByText } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));
    fireEvent.click(getByRole("button", { name: "Cancel" }));

    expect(queryByText("Create a custom plan")).toBeNull();
    expect(upgradeCall).toBeNull();
  });
});

describe("CustomPlanModal — eligible Pro subscriber", () => {
  test("Configure opens the white configurator, not the manage modal", () => {
    const { getByRole, getByTestId, getByText } = renderPage(
      proMightySubscription(),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));

    getByText("Create a custom plan");
    // The manage/cancel fallback route was not taken.
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(upgradeCall).toBeNull();
  });

  test("holds Configure disabled while the current tiers load, without misrouting", () => {
    // The onboarding query (which supplies the current tiers) is still in
    // flight. Representability is unknown, so the CTA is disabled rather than
    // falling through to the manage surface and stranding an eligible sub.
    onboardingHangs = true;
    const { getByRole, getByTestId, queryByText } = renderPage(
      proMightySubscription(),
      onboarding(),
      { seedOnboarding: false },
    );

    const configure = getByRole("button", { name: "Configure" });
    expect((configure as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(configure);
    expect(queryByText("Create a custom plan")).toBeNull();
    // The manage/cancel fallback route was not taken.
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
  });

  test("opens seeded to the current plan so Continue needs no re-pick", () => {
    // Current config: medium machine / 10 GB (xs) storage / no credits. The
    // configurator opens with all three pre-filled, so an unrelated edit can't
    // strand the user into re-picking — and dropping — a tier they still hold.
    const { getByRole, getByText } = renderPage(proMightySubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    getByText("Create a custom plan");
    // Seeded, so Continue is enabled with no interaction.
    expect(continueButton().disabled).toBe(false);

    // The recap reflects the seeded current tiers.
    expect(recapRows()).toEqual([
      "Pro base plan — $20/mo",
      "Medium machine (2.5 vCPU, 5 GiB)",
      "10 GB storage",
      "No extra credits",
    ]);
  });

  test("a seeded no-op shows the plain grey-check recap with no delta line", () => {
    // Opening seeded to the current plan with no interaction: every dimension
    // matches the seed, so no row is struck through and the delta line is hidden.
    const { getByRole } = renderPage(proMightySubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    expect(recapRows()).toEqual([
      "Pro base plan — $20/mo",
      "Medium machine (2.5 vCPU, 5 GiB)",
      "10 GB storage",
      "No extra credits",
    ]);
    expect(deltaLine()).toBeNull();
    expect(strikethroughs()).toEqual([]);
  });

  test("a machine upgrade struck-throughs the previous value with a green up delta", () => {
    // Seed: medium machine / 10 GB (xs) storage / no credits.
    const { getByRole } = renderPage(proMightySubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));
    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");

    // The changed machine row shows the previous value struck through above
    // the new value; every other row keeps its single seeded label.
    expect(strikethroughs()).toEqual(["Medium machine (2.5 vCPU, 5 GiB)"]);
    expect(recapRows()).toEqual([
      "Pro base plan — $20/mo",
      "Medium machine (2.5 vCPU, 5 GiB)Large machine (4 vCPU, 8 GiB)",
      "10 GB storage",
      "No extra credits",
    ]);

    // Only the changed row's check goes green; the rest stay grey.
    const checks = checkIconClasses();
    expect(checks).toHaveLength(4);
    expect(checks[1]).toContain("text-[var(--system-positive-strong)]");
    for (const unchanged of [checks[0], checks[2], checks[3]]) {
      expect(unchanged).toContain("text-[var(--content-secondary)]");
    }

    // previous = base 2000 + medium 3500 + xs 500 = 6000 ($60);
    // new = base 2000 + large 6000 + xs 500 = 8500 ($85); delta = +$25/mo.
    const delta = deltaLine();
    expect(delta).not.toBeNull();
    expect(delta!.textContent).toBe("+$25/mo compared to previous ($60)");
    expect(delta!.className).toContain("text-[var(--system-positive-strong)]");
  });

  test("a cheaper reconfigure shows a red down delta with the U+2212 minus", () => {
    // Seed machine to large; lowering to medium is cheaper.
    const { getByRole } = renderPage(
      proMightySubscription(),
      onboarding({ max_machine_tier: "large" }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    selectOption("Machine size", "Medium machine (2.5 vCPU, 5 GiB)");

    // previous = base 2000 + large 6000 + xs 500 = 8500 ($85);
    // new = base 2000 + medium 3500 + xs 500 = 6000 ($60); delta = −$25/mo.
    const delta = deltaLine();
    expect(delta).not.toBeNull();
    expect(delta!.textContent).toBe("−$25/mo compared to previous ($85)");
    expect(delta!.className).toContain("text-[var(--system-negative-strong)]");
  });

  test("continuing with the seeded config is a no-op with no dispatch", async () => {
    const { getByRole, queryByText, queryByTestId } = renderPage(
      proMightySubscription(),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    fireEvent.click(continueButton());

    // Nothing diverged from the current plan, so no change-tier request fires
    // and the resize takeover stays closed.
    await waitFor(() => expect(queryByText("Create a custom plan")).toBeNull());
    expect(machineTierCall).toBeNull();
    expect(storageTierCall).toBeNull();
    expect(creditTierCall).toBeNull();
    expect(queryByTestId("resize-takeover")).toBeNull();
  });

  test("a baseline (null machine) Pro sub can still open and reconfigure", () => {
    // A package with no paid machine tier reports max_machine_tier: null. That
    // sub must still reach the modal (not route to manage); storage/credit seed
    // and the machine picker starts empty, so Continue waits for a machine pick.
    const { getByRole, getByText } = renderPage(
      proMightySubscription(),
      onboarding({ max_machine_tier: null }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    getByText("Create a custom plan");
    expect(continueButton().disabled).toBe(true);

    // Storage and credit are seeded even though the machine is unset.
    const rows = recapRows();
    expect(rows).toContain("10 GB storage");
    expect(rows).toContain("No extra credits");
  });

  test("a baseline Pro sub picking a machine dispatches the upgrade", async () => {
    const { getByRole, findByTestId } = renderPage(
      proMightySubscription(),
      onboarding({ max_machine_tier: null }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    selectOption("Machine size", "Medium machine (2.5 vCPU, 5 GiB)");
    fireEvent.click(continueButton());

    await waitFor(() => expect(machineTierCall).not.toBeNull());
    expect(machineTierCall!.body).toEqual({ machine_tier: "medium" });
    // Storage and credit stayed at their seeded values, so neither dispatches.
    expect(storageTierCall).toBeNull();
    expect(creditTierCall).toBeNull();
    // Baseline → medium is an upgrade, so the resize takeover opens.
    const takeover = await findByTestId("resize-takeover");
    expect(takeover.getAttribute("data-mode")).toBe("resize");
  });

  test("Continue dispatches only the changed tiers and opens the resize takeover", async () => {
    // Current config is medium machine / 10 GB (xs) storage / no credits.
    const { getByRole, findByTestId } = renderPage(proMightySubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    // Raise the machine, keep storage at its current size, add a credit bundle.
    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    selectOption("Storage", "10 GB");
    selectOption("Credit bundle", "50 credits");
    fireEvent.click(continueButton());

    await waitFor(() => expect(machineTierCall).not.toBeNull());
    expect(machineTierCall!.body).toEqual({ machine_tier: "large" });
    expect(creditTierCall!.body).toEqual({ credit_tier: "credits_50" });
    // Storage is unchanged, so no storage-tier request fires.
    expect(storageTierCall).toBeNull();

    // A machine change resizes the assistant, so the takeover opens.
    const takeover = await findByTestId("resize-takeover");
    expect(takeover.getAttribute("data-mode")).toBe("resize");
    // The change-tier path never touches the checkout endpoint.
    expect(upgradeCall).toBeNull();
    expect(openedUrl).toBeNull();
  });

  test("a machine downgrade dispatches but skips the resize takeover", async () => {
    // Current machine is large; lowering to medium is a downgrade, capped
    // server-side, so it must not open the Apply & Restart takeover.
    const { getByRole, queryByText, queryByTestId } = renderPage(
      proMightySubscription(),
      onboarding({ max_machine_tier: "large" }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    selectOption("Machine size", "Medium machine (2.5 vCPU, 5 GiB)");
    fireEvent.click(continueButton());

    await waitFor(() => expect(machineTierCall).not.toBeNull());
    expect(machineTierCall!.body).toEqual({ machine_tier: "medium" });
    // The modal closes and the takeover never opens for a downgrade.
    await waitFor(() => expect(queryByText("Create a custom plan")).toBeNull());
    expect(queryByTestId("resize-takeover")).toBeNull();
  });

  test("storage tiers below the current size are disabled", () => {
    // Current storage is 30 GB (s), so the 10 GB tier can't be selected.
    const { getByRole } = renderPage(
      proMightySubscription(),
      onboarding({ selected_storage_tier: "s", selected_storage_gib: 30 }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    openDropdown("Storage");

    expect(findOption("10 GB").getAttribute("aria-disabled")).toBe("true");
    expect(findOption("30 GB").getAttribute("aria-disabled")).toBe("false");
  });

  test("a failed dispatch keeps the modal open and skips the takeover", async () => {
    machineTierError = { detail: "Payment failed. Your card was declined." };
    const { getByRole, getByText, queryByTestId } = renderPage(
      proMightySubscription(),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    selectOption("Storage", "10 GB");
    selectOption("Credit bundle", "No extra credits");
    fireEvent.click(continueButton());

    await waitFor(() => expect(machineTierCall).not.toBeNull());
    // The hook toasted; the configurator stays open and the takeover is absent.
    getByText("Create a custom plan");
    expect(queryByTestId("resize-takeover")).toBeNull();
  });
});

describe("CustomPlanModal — Pro plan the catalog can't fully represent", () => {
  test("a deprecated credit bundle Pro sub's Configure opens the custom-plan modal", () => {
    // The configurator only offers live credit tiers; the sub's `credits_25`
    // bundle is absent from the catalog. Configure still opens the modal — the
    // seed keeps the held credit, and an apply the backend can't honor surfaces
    // as a toast instead of the takeover pre-empting the modal.
    const { getByRole, getByTestId, getByText } = renderPage(
      proMightySubscription({ selected_credit_tier: "credits_25" }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));

    getByText("Create a custom plan");
    expect(getByTestId("loc").textContent).toBe("/assistant/plans");
    expect(machineTierCall).toBeNull();
  });

  test("an untouched deprecated credit bundle is not recapped as 'No extra credits'", () => {
    const { getByRole } = renderPage(
      proMightySubscription({ selected_credit_tier: "credits_25" }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));

    // The held bundle has no catalog entry to label, so the row is omitted
    // rather than claiming the paying subscriber has no credits.
    expect(recapRows()).toEqual([
      "Pro base plan — $20/mo",
      "Medium machine (2.5 vCPU, 5 GiB)",
      "10 GB storage",
    ]);
  });

  test("a legacy-storage Pro sub sees the held tier and can continue", () => {
    // 250 GB (xl) is legacy: no longer offered, but still what this sub pays
    // for. The picker shows it (disabled), the recap agrees with the total, and
    // Continue is live so an unrelated edit isn't blocked.
    const { getByRole, getByText } = renderPage(
      proMightySubscription(),
      onboarding({ selected_storage_tier: "xl", selected_storage_gib: 250 }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));

    expect(continueButton().disabled).toBe(false);
    expect(dropdownTrigger("Storage").textContent).toContain("250 GB");
    expect(recapRows()).toEqual([
      "Pro base plan — $20/mo",
      "Medium machine (2.5 vCPU, 5 GiB)",
      "250 GB storage",
      "No extra credits",
    ]);
    // base $20 + medium $35 + legacy 250 GB $60.
    getByText("$115/mo");
  });

  test("the held legacy storage tier is offered but not selectable", () => {
    const { getByRole } = renderPage(
      proMightySubscription(),
      onboarding({ selected_storage_tier: "xl", selected_storage_gib: 250 }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    openDropdown("Storage");

    expect(findOption("250 GB").getAttribute("aria-disabled")).toBe("true");
  });

  test("a seed machine the catalog dropped hides the delta rather than inverting it", () => {
    // `xl` is a valid machine tier the fixture catalog no longer lists. Pricing
    // it at $0 would report this downgrade to Medium as a $35 increase.
    const { getByRole } = renderPage(
      proMightySubscription(),
      onboarding({ max_machine_tier: "xl" }),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));
    selectOption("Machine size", "Medium machine (2.5 vCPU, 5 GiB)");

    expect(deltaLine()).toBeNull();
  });
});
