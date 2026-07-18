/**
 * Interaction tests for the Custom Plan configurator modal.
 *
 * A base subscriber clicking Configure gets the "Create a custom plan" modal;
 * Continue stays disabled until all three dropdowns (machine size, storage,
 * credits) have an explicit choice, then fires the Stripe upgrade with the
 * selected tiers. A Pro subscriber's Configure routes to the billing manage
 * modal instead, mirroring the plan-card CTAs.
 *
 * Strategy mirrors plans-page-checkout.test.tsx: mock the generated SDK to
 * capture the upgrade body and return a redirect, mock `openUrl` to capture
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
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  PlanListResponse,
  ProPackage,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

const CHECKOUT_URL = "https://stripe.test/checkout/session";

type Captured = { body?: unknown };
let upgradeCall: Captured | null = null;
let openedUrl: string | null = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCall = opts;
    return Promise.resolve({
      data: { status: "redirect", checkout_url: CHECKOUT_URL },
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
            label: "10 GiB",
            storage_gib: 10,
            price_cents: 500,
            lookup_key: "storage_10",
            legacy: false,
          },
          {
            tier: "s",
            label: "30 GiB",
            storage_gib: 30,
            price_cents: 1000,
            lookup_key: "storage_30",
            legacy: false,
          },
          {
            tier: "xl",
            label: "250 GiB",
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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderPage(subscription: SubscriptionResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(
    organizationsBillingPlansRetrieveQueryKey(),
    fullCatalog(),
  );
  return render(
    <MemoryRouter initialEntries={["/assistant/plans"]}>
      <QueryClientProvider client={client}>
        <PlansPage />
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function openDropdown(ariaLabel: string): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${ariaLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a "${ariaLabel}" dropdown trigger`);
  }
  fireEvent.click(trigger);
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
  openedUrl = null;
});

afterEach(() => {
  cleanup();
});

describe("CustomPlanModal — base subscriber", () => {
  test("Continue stays disabled until every dropdown has a choice", () => {
    const { getByRole, getByText } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));
    getByText("Create a custom plan");

    expect(continueButton().disabled).toBe(true);

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    expect(continueButton().disabled).toBe(true);

    selectOption("Storage", "30 GiB");
    expect(continueButton().disabled).toBe(true);

    selectOption("Credit bundle", "No extra credits");
    expect(continueButton().disabled).toBe(false);
  });

  test("legacy storage tiers are not offered", () => {
    const { getByRole } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));
    openDropdown("Storage");

    const labels = optionLabels();
    expect(labels.some((l) => l.startsWith("30 GiB"))).toBe(true);
    expect(labels.some((l) => l.startsWith("250 GiB"))).toBe(false);
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
    selectOption("Storage", "30 GiB");
    selectOption("Credit bundle", "50 credits");

    // $20 base + $60 machine + $10 storage + $50 credits.
    getByText("$140/mo");

    // The recap check-list is the only <ul> in the dialog once the dropdown
    // menus are closed. (The machine text also appears in its trigger, so a
    // plain getByText would double-match.)
    const dialog = document.querySelector('[role="dialog"]');
    const rows = Array.from(dialog?.querySelectorAll("li") ?? []).map(
      (li) => li.textContent?.trim() ?? "",
    );
    expect(rows).toEqual([
      "Pro base plan — $20/mo",
      "Large machine (4 vCPU, 8 GiB)",
      "30 GiB storage",
      "$50 of bundled credits",
    ]);
  });

  test("Continue starts a Stripe checkout with the selected tiers", async () => {
    const { getByRole } = renderPage(freeSubscription());

    fireEvent.click(getByRole("button", { name: "Configure" }));

    selectOption("Machine size", "Large machine (4 vCPU, 8 GiB)");
    selectOption("Storage", "30 GiB");
    selectOption("Credit bundle", "No extra credits");
    fireEvent.click(continueButton());

    await waitFor(() => expect(upgradeCall).not.toBeNull());
    expect(upgradeCall!.body).toEqual({
      target_plan_id: "pro",
      confirm: true,
      machine_tier: "large",
      storage_tier: "s",
      credit_tier: null,
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

describe("CustomPlanModal — Pro subscriber", () => {
  test("Configure routes to the manage modal instead of the configurator", async () => {
    const { getByRole, getByTestId, queryByText } = renderPage(
      proMightySubscription(),
    );

    fireEvent.click(getByRole("button", { name: "Configure" }));

    await waitFor(() => {
      expect(getByTestId("loc").textContent).toBe(
        "/assistant/settings/billing?adjust_plan",
      );
    });
    expect(queryByText("Create a custom plan")).toBeNull();
    expect(upgradeCall).toBeNull();
  });
});
