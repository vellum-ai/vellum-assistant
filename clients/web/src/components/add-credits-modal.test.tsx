import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { routes } from "@/utils/routes";

// Captured so tests can fire the "user came back from checkout" signal, which
// on native is the only notification the app gets.
let browserFinished: (() => void) | null = null;
let openedUrls: string[] = [];
mock.module("@/runtime/browser", () => ({
  openUrl: (url: string) => {
    openedUrls.push(url);
    return Promise.resolve();
  },
  openUrlFinishedListener: (cb: () => void) => {
    browserFinished = cb;
    return () => {
      browserFinished = null;
    };
  },
}));

let mockIsElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => mockIsElectron,
}));

// Stub the generated billing endpoints so the summary resolves and the
// Continue button enables — otherwise every checkout-launch assertion would be
// vacuously true against a permanently disabled button.
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSummaryRetrieveOptions: () => ({
    queryKey: ["billing-summary"],
    queryFn: async () => ({ allowed_top_up_amounts: ["10.00", "20.00"] }),
  }),
  organizationsBillingTopUpsCheckoutSessionCreateMutation: () => ({
    mutationFn: async () => ({ checkout_url: "https://stripe.test/session" }),
  }),
}));

const { AddCreditsModal } = await import("@/components/add-credits-modal");

afterEach(() => {
  cleanup();
  browserFinished = null;
  mockIsElectron = false;
  openedUrls = [];
});

function renderModal(props: { onCheckoutReturn?: () => void } = {}) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddCreditsModal open onOpenChange={() => {}} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AddCreditsModal", () => {
  test("renders the updated copy and labels", () => {
    renderModal();

    expect(screen.getByText("Add Credits")).toBeTruthy();
    expect(
      screen.getByText(
        "You'll be redirected to Stripe to complete the payment.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  test("links the automatic top-ups control to the billing route", () => {
    renderModal();

    const link = screen.getByRole("link", {
      name: /Configure Automatic Top-Ups/,
    });
    expect(link.getAttribute("href")).toBe(routes.settings.usageBilling);
  });

  test("notifies the caller when the user returns from checkout", () => {
    // On native the app state survives checkout, so callers that latched off
    // the old balance (a surface disabled because credits ran out) need this
    // signal to reconcile — without it they stay stale against a topped-up
    // account.
    const onCheckoutReturn = mock(() => {});
    renderModal({ onCheckoutReturn });

    act(() => {
      browserFinished?.();
    });

    expect(onCheckoutReturn).toHaveBeenCalledTimes(1);
  });

  test("survives a checkout return with no caller hook", () => {
    renderModal();

    expect(() => {
      act(() => {
        browserFinished?.();
      });
    }).not.toThrow();
  });

  describe("Electron checkout return", () => {
    // Electron hands checkout to the *system* browser and `browserFinished` is
    // Capacitor-only, so regaining window focus is the only available signal
    // that the user came back. Without it the modal sits open and callers stay
    // latched to the pre-top-up balance.
    test("regaining focus after launching checkout reports the return", async () => {
      mockIsElectron = true;
      const onCheckoutReturn = mock(() => {});
      renderModal({ onCheckoutReturn });

      // Launch checkout for real — that is what arms the focus handler.
      const button = await screen.findByRole("button", { name: "Continue" });
      await waitFor(() => {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      });
      fireEvent.click(button);
      await waitFor(() => {
        expect(openedUrls).toEqual(["https://stripe.test/session"]);
      });

      act(() => {
        window.dispatchEvent(new Event("focus"));
      });

      expect(onCheckoutReturn).toHaveBeenCalledTimes(1);
    });

    test("only the first refocus counts — later ones are ordinary app use", async () => {
      mockIsElectron = true;
      const onCheckoutReturn = mock(() => {});
      renderModal({ onCheckoutReturn });

      const button = await screen.findByRole("button", { name: "Continue" });
      await waitFor(() => {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      });
      fireEvent.click(button);
      await waitFor(() => {
        expect(openedUrls).toHaveLength(1);
      });

      act(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
      });

      expect(onCheckoutReturn).toHaveBeenCalledTimes(1);
    });

    test("focus without a launched checkout is ignored", () => {
      mockIsElectron = true;
      const onCheckoutReturn = mock(() => {});
      renderModal({ onCheckoutReturn });

      act(() => {
        window.dispatchEvent(new Event("focus"));
      });

      expect(onCheckoutReturn).not.toHaveBeenCalled();
    });

    test("no focus handler off Electron — native uses browserFinished", () => {
      const onCheckoutReturn = mock(() => {});
      renderModal({ onCheckoutReturn });

      act(() => {
        window.dispatchEvent(new Event("focus"));
      });

      expect(onCheckoutReturn).not.toHaveBeenCalled();
    });
  });
});
