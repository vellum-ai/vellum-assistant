import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { routes } from "@/utils/routes";

mock.module("@/runtime/browser", () => ({
  openUrl: () => Promise.resolve(),
  openUrlFinishedListener: () => () => {},
}));

const { AddCreditsModal } = await import("@/components/add-credits-modal");

afterEach(() => {
  cleanup();
});

function renderModal() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddCreditsModal open onOpenChange={() => {}} />
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
});
