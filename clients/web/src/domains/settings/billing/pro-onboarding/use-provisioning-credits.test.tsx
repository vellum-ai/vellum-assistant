/**
 * Tests for `useProvisioningCredits`. The plan catalog is seeded straight into
 * the React Query cache so `useQuery` resolves synchronously without a fetch —
 * mirrors the `plan-card.test.tsx` `setQueryData` pattern.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { organizationsBillingPlansRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { PlanListResponse } from "@/generated/api/types.gen";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";

// Drives the org-readiness gate — the plans lookup must stay idle until the
// organization store hydrates, or it fires without a `Vellum-Organization-Id`.
let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useProvisioningCredits, useCreditTierLabel } = await import(
  "./use-provisioning-credits"
);

/** A pro-plan catalog with a `credits_50` tier and a Mighty package on it. */
function plansResponse(): PlanListResponse {
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
        credit_tiers: [
          {
            tier: "credits_50",
            label: "$50 credits/mo",
            credits_usd: 50,
            price_cents: 5000,
            lookup_key: "credits_50_key",
            legacy: false,
          },
        ],
        packages: [
          {
            key: "mighty",
            name: "Mighty",
            description: "",
            version: 1,
            machine_tier: null,
            storage_tier: "xs",
            credit_tier: "credits_50",
            machine_size: null,
            storage_gib: 10,
            credits_usd: 50,
            include_platform_fee: false,
            base_price_cents: 4000,
            machine_price_cents: 0,
            storage_price_cents: 0,
            credit_price_cents: 0,
            total_price_cents: 4000,
          },
          {
            key: "orphan",
            name: "Orphan",
            description: "",
            version: 1,
            machine_tier: null,
            storage_tier: "xs",
            credit_tier: "credits_999",
            machine_size: null,
            storage_gib: 10,
            credits_usd: 30,
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

function renderWithClient(
  intent: CheckoutIntent | null,
  plans?: PlanListResponse,
): { value: string | null; client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (plans) {
    client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const value = renderHook(() => useProvisioningCredits(intent), { wrapper })
    .result.current;
  return { value, client };
}

function renderCredits(
  intent: CheckoutIntent | null,
  plans?: PlanListResponse,
): string | null {
  return renderWithClient(intent, plans).value;
}

describe("useProvisioningCredits", () => {
  beforeEach(() => {
    orgReady = true;
  });

  test("holds the plans lookup until the org is ready", () => {
    orgReady = false;
    const { value, client } = renderWithClient({
      kind: "package",
      packageKey: "mighty",
      savedAt: 0,
    });

    expect(value).toBeNull();
    expect(
      client.getQueryState(organizationsBillingPlansRetrieveQueryKey())
        ?.fetchStatus ?? "idle",
    ).toBe("idle");
  });

  test("holds the plans lookup when there is no intent", () => {
    const { client } = renderWithClient(null);

    expect(
      client.getQueryState(organizationsBillingPlansRetrieveQueryKey())
        ?.fetchStatus ?? "idle",
    ).toBe("idle");
  });

  test("returns null for a null intent", () => {
    expect(renderCredits(null, plansResponse())).toBeNull();
  });

  test("returns null while the catalog is unresolved", () => {
    expect(
      renderCredits({ kind: "package", packageKey: "mighty", savedAt: 0 }),
    ).toBeNull();
  });

  test("resolves a package's credit tier label", () => {
    expect(
      renderCredits(
        { kind: "package", packageKey: "mighty", savedAt: 0 },
        plansResponse(),
      ),
    ).toBe("$50 credits/mo");
  });

  test("falls back to the package's credits_usd when no tier matches", () => {
    expect(
      renderCredits(
        { kind: "package", packageKey: "orphan", savedAt: 0 },
        plansResponse(),
      ),
    ).toBe("30 credits");
  });

  test("returns null for an unknown package key", () => {
    expect(
      renderCredits(
        { kind: "package", packageKey: "nope", savedAt: 0 },
        plansResponse(),
      ),
    ).toBeNull();
  });

  test("resolves a custom intent's credit tier label", () => {
    expect(
      renderCredits(
        {
          kind: "custom",
          machineTier: null,
          storageTier: null,
          creditTier: "credits_50",
          savedAt: 0,
        },
        plansResponse(),
      ),
    ).toBe("$50 credits/mo");
  });

  test("returns null for a custom intent without credits", () => {
    expect(
      renderCredits(
        {
          kind: "custom",
          machineTier: "large",
          storageTier: "xl",
          creditTier: null,
          savedAt: 0,
        },
        plansResponse(),
      ),
    ).toBeNull();
  });
});

describe("useCreditTierLabel", () => {
  beforeEach(() => {
    orgReady = true;
  });

  function renderLabel(
    creditTier: Parameters<typeof useCreditTierLabel>[0],
    plans?: PlanListResponse,
  ): { value: string | null; client: QueryClient } {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (plans) {
      client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
    }
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const value = renderHook(() => useCreditTierLabel(creditTier), { wrapper })
      .result.current;
    return { value, client };
  }

  test("resolves a credit tier's catalog label", () => {
    expect(renderLabel("credits_50", plansResponse()).value).toBe(
      "$50 credits/mo",
    );
  });

  test("returns null while the catalog is unresolved", () => {
    expect(renderLabel("credits_50").value).toBeNull();
  });

  test("returns null for a tier absent from the catalog", () => {
    expect(renderLabel("credits_100", plansResponse()).value).toBeNull();
  });

  test("returns null — and holds the lookup — for a null tier", () => {
    const { value, client } = renderLabel(null, plansResponse());
    expect(value).toBeNull();
    expect(
      client.getQueryState(organizationsBillingPlansRetrieveQueryKey())
        ?.fetchStatus ?? "idle",
    ).toBe("idle");
  });

  test("holds the lookup until the org is ready", () => {
    orgReady = false;
    const { value, client } = renderLabel("credits_50");
    expect(value).toBeNull();
    expect(
      client.getQueryState(organizationsBillingPlansRetrieveQueryKey())
        ?.fetchStatus ?? "idle",
    ).toBe("idle");
  });
});
