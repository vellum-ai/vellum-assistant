import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { MfaFactor } from "@/generated/api/types.gen";

let listResult: MfaFactor[] = [];
let destroyCalls: { path: { id: string } }[] = [];
let destroyError: unknown = null;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  userMfaFactorsListQueryKey: () => ["userMfaFactorsList"],
  userMfaFactorsListOptions: () => ({
    queryKey: ["userMfaFactorsList"],
    queryFn: async () => listResult,
  }),
  useUserMfaFactorsDestroyMutation: (options?: {
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (variables: { path: { id: string } }) => {
      destroyCalls.push(variables);
      if (destroyError) {
        options?.onError?.(destroyError);
      } else {
        options?.onSuccess?.();
      }
    },
  }),
}));

mock.module("./enroll-totp-modal", () => ({
  EnrollTotpModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="enroll-modal" /> : null,
}));

const { TwoFactorSection } = await import("./two-factor-section");

const FACTOR: MfaFactor = {
  id: "auth_factor_01ABC",
  type: "totp",
  issuer: "Vellum",
  user: "alice@example.com",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TwoFactorSection />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  listResult = [];
  destroyCalls = [];
  destroyError = null;
});

describe("TwoFactorSection", () => {
  test("shows the empty state and add button when no factor exists", async () => {
    renderSection();

    await waitFor(() =>
      expect(screen.getByText(/No authenticator app is set up/i)).not.toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Add authenticator app" }),
    ).not.toBeNull();
  });

  test("lists enrolled factors with their label", async () => {
    listResult = [FACTOR];
    renderSection();

    await waitFor(() =>
      expect(screen.getByText("Authenticator app")).not.toBeNull(),
    );
    expect(screen.getByText(/alice@example\.com/)).not.toBeNull();
    // One factor max: no add affordance once enrolled.
    expect(
      screen.queryByRole("button", { name: "Add authenticator app" }),
    ).toBeNull();
  });

  test("opens the enroll modal from the add button", async () => {
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add authenticator app" }),
      ).not.toBeNull(),
    );
    await user.click(
      screen.getByRole("button", { name: "Add authenticator app" }),
    );

    expect(screen.getByTestId("enroll-modal")).not.toBeNull();
  });

  test("removing a factor requires confirmation and calls the delete mutation", async () => {
    const user = userEvent.setup();
    listResult = [FACTOR];
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove" })).not.toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(destroyCalls).toHaveLength(0);

    // The dialog's confirm button is the last "Remove" in the tree.
    const removeButtons = await screen.findAllByRole("button", {
      name: "Remove",
    });
    await user.click(removeButtons[removeButtons.length - 1]!);
    await waitFor(() => expect(destroyCalls).toHaveLength(1));
    expect(destroyCalls[0]).toEqual({ path: { id: "auth_factor_01ABC" } });
  });
});
