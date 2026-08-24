/**
 * Tests for the credits resolution behind the takeover's from-to chip. The plan
 * catalog is seeded straight into the React Query cache so `useQuery` resolves
 * synchronously without a fetch, mirroring the `plan-card.test.tsx`
 * `setQueryData` pattern.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { organizationsBillingPlansRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTierEnum,
  PlanListResponse,
} from "@/generated/api/types.gen";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";

import type {
  CreditsChange,
  CreditTierChange,
} from "./use-provisioning-credits";

// Drives the org-readiness gate — the plans lookup must stay idle until the
// organization store hydrates, or it fires without a `Vellum-Organization-Id`.
let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useProvisioningCredits, useResizeCreditsChange } =
  await import("./use-provisioning-credits");

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
            usage_label: "Mighty Usage",
            include_platform_fee: false,
            base_price_cents: 4000,
            machine_price_cents: 0,
            storage_price_cents: 0,
            credit_price_cents: 0,
            total_price_cents: 4000,
          },
          {
            key: "tierless",
            name: "Tierless",
            description: "",
            version: 1,
            machine_tier: null,
            storage_tier: "xs",
            credit_tier: "credits_50",
            machine_size: null,
            storage_gib: 10,
            credits_usd: null,
            usage_label: null,
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

function withClient<T>(
  hook: () => T,
  plans?: PlanListResponse,
): { value: T; client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (plans) {
    client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { value: renderHook(hook, { wrapper }).result.current, client };
}

/** "idle" unless the plans query actually went out. */
function plansFetchStatus(client: QueryClient): string {
  return (
    client.getQueryState(organizationsBillingPlansRetrieveQueryKey())
      ?.fetchStatus ?? "idle"
  );
}

describe("useProvisioningCredits", () => {
  beforeEach(() => {
    orgReady = true;
  });

  function renderCredits(
    intent: CheckoutIntent | null,
    plans?: PlanListResponse,
  ): CreditsChange | null {
    return withClient(() => useProvisioningCredits(intent), plans).value;
  }

  test("holds the plans lookup until the org is ready", () => {
    orgReady = false;
    const { value, client } = withClient(() =>
      useProvisioningCredits({
        kind: "package",
        packageKey: "mighty",
        savedAt: 0,
      }),
    );

    expect(value).toBeNull();
    expect(plansFetchStatus(client)).toBe("idle");
  });

  test("holds the plans lookup when there is no intent", () => {
    const { client } = withClient(() => useProvisioningCredits(null));

    expect(plansFetchStatus(client)).toBe("idle");
  });

  test("returns null for a null intent", () => {
    expect(renderCredits(null, plansResponse())).toBeNull();
  });

  test("returns null while the catalog is unresolved", () => {
    expect(
      renderCredits({ kind: "package", packageKey: "mighty", savedAt: 0 }),
    ).toBeNull();
  });

  test("resolves a package's credits from $0, since the base plan bundles none", () => {
    expect(
      renderCredits(
        { kind: "package", packageKey: "mighty", savedAt: 0 },
        plansResponse(),
      ),
    ).toEqual({ fromUsd: 0, toUsd: 50 });
  });

  test("falls back to the package's credit tier when it carries no credits_usd", () => {
    expect(
      renderCredits(
        { kind: "package", packageKey: "tierless", savedAt: 0 },
        plansResponse(),
      ),
    ).toEqual({ fromUsd: 0, toUsd: 50 });
  });

  test("returns null for an unknown package key", () => {
    expect(
      renderCredits(
        { kind: "package", packageKey: "nope", savedAt: 0 },
        plansResponse(),
      ),
    ).toBeNull();
  });

  test("resolves a custom intent's credit tier", () => {
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
    ).toEqual({ fromUsd: 0, toUsd: 50 });
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

describe("useResizeCreditsChange", () => {
  beforeEach(() => {
    orgReady = true;
  });

  function renderChange(
    change: CreditTierChange | null | undefined,
    plans?: PlanListResponse,
  ): CreditsChange | null {
    return withClient(() => useResizeCreditsChange(change), plans).value;
  }

  test("resolves both sides from the catalog", () => {
    expect(
      renderChange({ fromTier: null, toTier: "credits_50" }, plansResponse()),
    ).toEqual({ fromUsd: 0, toUsd: 50 });
  });

  test("reads a dropped bundle as a move down to $0", () => {
    // "No extra credits" is a real endpoint of the change, not a missing side.
    expect(
      renderChange({ fromTier: "credits_50", toTier: null }, plansResponse()),
    ).toEqual({ fromUsd: 50, toUsd: 0 });
  });

  test("reads a held tier the catalog no longer lists off its key", () => {
    // A grandfathered bundle is absent from the offered tiers, so the catalog
    // can't price it; its key carries the dollars.
    expect(
      renderChange(
        { fromTier: "credits_115", toTier: "credits_50" },
        plansResponse(),
      ),
    ).toEqual({ fromUsd: 115, toUsd: 50 });
  });

  test("omits the chip when a tier carries no resolvable amount", () => {
    // Version skew: the server names a tier this bundle's enum doesn't list and
    // whose key holds no dollar figure. A wrong number is worse than no chip.
    const skewedTier = "credits_unlimited" as unknown as CreditTierEnum;
    expect(
      renderChange(
        { fromTier: skewedTier, toTier: "credits_50" },
        plansResponse(),
      ),
    ).toBeNull();
  });

  test("returns null and holds the lookup with no change threaded", () => {
    const { value, client } = withClient(
      () => useResizeCreditsChange(undefined),
      plansResponse(),
    );

    expect(value).toBeNull();
    expect(plansFetchStatus(client)).toBe("idle");
  });

  test("holds the lookup until the org is ready", () => {
    orgReady = false;
    const { client } = withClient(() =>
      useResizeCreditsChange({ fromTier: null, toTier: "credits_50" }),
    );

    expect(plansFetchStatus(client)).toBe("idle");
  });
});
