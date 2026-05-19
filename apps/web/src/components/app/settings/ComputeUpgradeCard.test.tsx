/**
 * Tests for `ComputeUpgradeCard`. Mirrors the `AdjustPlanModal.test.tsx`
 * mocking strategy — `bun:test` cannot drive a real network, so we mock
 * `@tanstack/react-query` and the heyapi client at the module level and
 * thread the per-test query/mutation state through closures.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@/test-utils.js";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Query / mutation stubs (registered before subject is imported)
// ---------------------------------------------------------------------------

interface QueryStub<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

let subscriptionQuery: QueryStub<unknown> = {
  data: undefined,
  isLoading: true,
  isError: false,
};

interface MutationCall {
  variables: unknown;
}

let upgradeMutation: {
  calls: MutationCall[];
  isPending: boolean;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
} = { calls: [], isPending: false };

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: () => subscriptionQuery,
  useMutation: (opts: {
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
  }) => {
    // Capture per-render callbacks so each test can drive success/error paths.
    upgradeMutation.onSuccess = opts.onSuccess;
    upgradeMutation.onError = opts.onError;
    return {
      mutate: (variables: unknown) => {
        upgradeMutation.calls.push({ variables });
      },
      isPending: upgradeMutation.isPending,
    };
  },
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSubscriptionRetrieve" }],
  }),
  assistantsProUpgradeMachineCreateMutation: () => ({
    _mutationId: "proUpgradeMachine",
  }),
}));

const toastError = mock((..._args: unknown[]) => {});

mock.module("@/components/app/core/Toast", () => ({
  toast: {
    error: toastError,
    info: () => {},
    success: () => {},
    warning: () => {},
  },
}));

// ---------------------------------------------------------------------------
// Subject (after mocks)
// ---------------------------------------------------------------------------

import { ComputeUpgradeCard } from "@/components/app/settings/ComputeUpgradeCard.js";
import type { Assistant } from "@/lib/assistants/api.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAssistant(
  overrides: Partial<Assistant> = {},
): Assistant {
  return {
    id: "asst_123",
    name: "Test Assistant",
    description: null,
    configuration: null,
    status: "ready",
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
    current_release_version: null,
    machine_id: null,
    vembda_cluster_id: null,
    machine_size: null,
    maintenance_mode: { enabled: false, debug_pod_name: null },
    is_local: false,
    ingress_url: null,
    ...overrides,
  } as Assistant;
}

const proSubscription = {
  plan_id: "pro",
  status: "active",
  renewal_date: null,
  current_period_end: null,
  cancel_at_period_end: false,
  cancel_at: null,
};

const baseSubscription = { ...proSubscription, plan_id: "base" };

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  subscriptionQuery = {
    data: undefined,
    isLoading: true,
    isError: false,
  };
  upgradeMutation = { calls: [], isPending: false };
  toastError.mockClear();
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

// ---------------------------------------------------------------------------
// Visibility / eligibility
// ---------------------------------------------------------------------------

describe("ComputeUpgradeCard — eligibility", () => {
  test("renders when plan_id is pro and machine_size is null", () => {
    subscriptionQuery = {
      data: proSubscription,
      isLoading: false,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    render(
      <ComputeUpgradeCard
        assistant={makeAssistant({ machine_size: null })}
        refetch={refetch}
      />,
    );
    expect(screen.getByText("Compute Profile")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Upgrade Compute" }),
    ).toBeTruthy();
  });

  test("renders when plan_id is pro and machine_size is small", () => {
    subscriptionQuery = {
      data: proSubscription,
      isLoading: false,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    render(
      <ComputeUpgradeCard
        assistant={makeAssistant({ machine_size: "small" })}
        refetch={refetch}
      />,
    );
    expect(screen.getByText("Compute Profile")).toBeTruthy();
  });

  test("renders when plan_id is pro and machine_size is empty string", () => {
    // The backend `machine_size` is a blankable CharField that can serialize as
    // `""` for never-upgraded assistants. Treat empty string the same as null /
    // "small" so the upgrade card stays reachable for those rows.
    subscriptionQuery = {
      data: proSubscription,
      isLoading: false,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    render(
      <ComputeUpgradeCard
        assistant={makeAssistant({
          machine_size: "" as unknown as Assistant["machine_size"],
        })}
        refetch={refetch}
      />,
    );
    expect(screen.getByText("Compute Profile")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Upgrade Compute" }),
    ).toBeTruthy();
  });

  test("does not render when plan_id is base", () => {
    subscriptionQuery = {
      data: baseSubscription,
      isLoading: false,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    const { container } = render(
      <ComputeUpgradeCard
        assistant={makeAssistant({ machine_size: "small" })}
        refetch={refetch}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("does not render when machine_size is medium", () => {
    subscriptionQuery = {
      data: proSubscription,
      isLoading: false,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    const { container } = render(
      <ComputeUpgradeCard
        assistant={makeAssistant({ machine_size: "medium" })}
        refetch={refetch}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("does not render when subscription is not yet loaded", () => {
    subscriptionQuery = {
      data: undefined,
      isLoading: true,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    const { container } = render(
      <ComputeUpgradeCard
        assistant={makeAssistant({ machine_size: "small" })}
        refetch={refetch}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Upgrade flow
// ---------------------------------------------------------------------------

describe("ComputeUpgradeCard — upgrade flow", () => {
  test("confirms then calls the mutation and triggers refetch on success", async () => {
    subscriptionQuery = {
      data: proSubscription,
      isLoading: false,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    render(
      <ComputeUpgradeCard
        assistant={makeAssistant({ id: "asst_xyz", machine_size: "small" })}
        refetch={refetch}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Upgrade Compute" }),
    );
    // ConfirmDialog renders an "Upgrade" button to confirm.
    await userEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    expect(upgradeMutation.calls).toHaveLength(1);
    expect(upgradeMutation.calls[0]!.variables).toEqual({
      path: { id: "asst_xyz" },
    });

    // Drive the success path manually (the stub doesn't auto-resolve).
    act(() => {
      upgradeMutation.onSuccess?.();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  test("shows error toast on failure and does not call refetch", async () => {
    subscriptionQuery = {
      data: proSubscription,
      isLoading: false,
      isError: false,
    };
    const refetch = mock(() => Promise.resolve());
    render(
      <ComputeUpgradeCard
        assistant={makeAssistant({ machine_size: "small" })}
        refetch={refetch}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Upgrade Compute" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    act(() => {
      upgradeMutation.onError?.(new Error("boom"));
    });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(
      "Failed to upgrade compute profile. Please try again.",
    );
    expect(refetch).not.toHaveBeenCalled();
  });
});
