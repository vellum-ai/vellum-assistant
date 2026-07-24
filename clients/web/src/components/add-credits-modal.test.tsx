import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { routes } from "@/utils/routes";

// Captured so tests can fire the "user came back from checkout" signal, which
// on native is the only notification the app gets.
let browserFinished: (() => void) | null = null;
mock.module("@/runtime/browser", () => ({
  openUrl: () => Promise.resolve(),
  openUrlFinishedListener: (cb: () => void) => {
    browserFinished = cb;
    return () => {
      browserFinished = null;
    };
  },
}));

const { AddCreditsModal } = await import("@/components/add-credits-modal");

afterEach(() => {
  cleanup();
  browserFinished = null;
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
});
