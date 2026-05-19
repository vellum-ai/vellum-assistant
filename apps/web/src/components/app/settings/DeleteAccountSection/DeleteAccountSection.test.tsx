import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@/test-utils.js";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// useMutation stub — captures mutate args and controls isPending.
// ---------------------------------------------------------------------------

let mutationIsPending = false;
let mutateArgs: {
  variables: unknown;
  callbacks: {
    onSuccess?: (data: unknown) => void | Promise<void>;
    onError?: (error: unknown) => void;
  };
} | null = null;

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useMutation: () => ({
    mutate: (
      variables: unknown,
      callbacks?: {
        onSuccess?: (data: unknown) => void | Promise<void>;
        onError?: (error: unknown) => void;
      },
    ) => {
      mutateArgs = { variables, callbacks: callbacks ?? {} };
    },
    isPending: mutationIsPending,
  }),
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  userDeletionRequestCreateMutation: () => ({
    _mutationId: "userDeletionRequestCreate",
  }),
}));

// ---------------------------------------------------------------------------
// Auth + router stubs.
// ---------------------------------------------------------------------------

const logoutMock = mock(async () => {});
const routerReplace = mock((..._args: unknown[]) => {});

mock.module("@/lib/auth.js", () => ({
  useAuth: () => ({
    logout: logoutMock,
  }),
}));

mock.module("next/navigation", () => ({
  useRouter: () => ({
    replace: routerReplace,
    push: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));

const toastSuccess = mock((..._args: unknown[]) => {});
const toastError = mock((..._args: unknown[]) => {});

mock.module("@/components/app/core/Toast/Toast", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
    info: () => {},
    warning: () => {},
  },
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER mocks above).
// ---------------------------------------------------------------------------

import { DeleteAccountSection } from "@/components/app/settings/DeleteAccountSection/DeleteAccountSection.js";

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mutationIsPending = false;
  mutateArgs = null;
  toastSuccess.mockClear();
  toastError.mockClear();
  logoutMock.mockClear();
  routerReplace.mockClear();
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe("DeleteAccountSection — rendering", () => {
  test("renders the Delete Account heading + subtitle", () => {
    render(<DeleteAccountSection />);
    expect(screen.getByText("Delete Account")).toBeTruthy();
    expect(
      screen.getByText(
        "Permanently delete your Vellum account and all associated data.",
      ),
    ).toBeTruthy();
  });

  test("renders the destructive trigger button", () => {
    render(<DeleteAccountSection />);
    expect(screen.getByTestId("delete-account-button")).toBeTruthy();
  });

  test("clicking the trigger button opens the confirm dialog", async () => {
    render(<DeleteAccountSection />);
    await userEvent.click(screen.getByTestId("delete-account-button"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Confirm-flow wiring
// ---------------------------------------------------------------------------

describe("DeleteAccountSection — confirm flow", () => {
  test("clicking confirm calls userDeletionRequestCreate mutation", async () => {
    render(<DeleteAccountSection />);
    await userEvent.click(screen.getByTestId("delete-account-button"));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete my account" }),
    );

    expect(mutateArgs).not.toBeNull();
    expect(mutateArgs!.variables).toEqual({});
  });

  test("onSuccess (201) signs the user out and redirects to marketing", async () => {
    render(<DeleteAccountSection />);
    await userEvent.click(screen.getByTestId("delete-account-button"));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete my account" }),
    );
    await mutateArgs!.callbacks.onSuccess?.(undefined);

    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0]![0]).toBe("/");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  test("onError shows the error toast with the locked copy", async () => {
    render(<DeleteAccountSection />);
    await userEvent.click(screen.getByTestId("delete-account-button"));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete my account" }),
    );
    mutateArgs!.callbacks.onError?.(new Error("boom"));

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(
      "Could not delete your account. Please try again or contact support.",
    );
    expect(logoutMock).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  test("isPending guard prevents double-fire while the request is in flight", () => {
    mutationIsPending = true;
    render(<DeleteAccountSection />);
    expect(screen.getByTestId("delete-account-button")).toBeDisabled();
  });
});
