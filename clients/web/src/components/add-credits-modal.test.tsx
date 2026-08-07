import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { routes } from "@/utils/routes";

let nativeAndroid = false;

mock.module("@/runtime/browser", () => ({
  openUrl: () => Promise.resolve(),
  openUrlFinishedListener: () => () => {},
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
}));

const { AddCreditsModal } = await import("@/components/add-credits-modal");

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  nativeAndroid = false;
  cleanup();
  __resetForTesting();
});

function renderModal(onOpenChange: (open: boolean) => void = () => {}) {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddCreditsModal open onOpenChange={onOpenChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

describe("AddCreditsModal", () => {
  test("native Android renders website guidance without checkout links", () => {
    nativeAndroid = true;
    renderModal();

    expect(
      screen.getByText("Manage your subscription on our website."),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

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
    expect(link.getAttribute("href")).toBe(
      routes.settings.usageBillingConfigureTopUps,
    );
  });
});

describe("AddCreditsModal checkout-complete deep-link cleanup", () => {
  // On Electron the Capacitor `browserFinished` listener never fires, so
  // the `flow=top_up` checkout-complete deep link is the only signal that
  // the system-browser checkout is over. The modal must dismiss itself on
  // it (both outcomes) so it does not sit over the success toast or the
  // billing page's cancel-triggered bonus-offer flow.

  test("closes and refetches the billing summary on a top_up success return", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { client } = renderModal(onOpenChange);
    const invalidateSpy = spyOn(client, "invalidateQueries");

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "success",
        sessionId: "cs_test_a1B2",
        flow: "top_up",
      });
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy.mock.calls[0]?.[0]).toMatchObject({
      queryKey: organizationsBillingSummaryRetrieveOptions().queryKey,
    });
  });

  test("closes on a top_up cancel return too, before the bonus-offer flow lands", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    renderModal(onOpenChange);

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "cancel",
        sessionId: null,
        flow: "top_up",
      });
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("ignores a subscription checkout return: not this modal's flow", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { client } = renderModal(onOpenChange);
    const invalidateSpy = spyOn(client, "invalidateQueries");

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "success",
        sessionId: "cs_test_a1B2",
        flow: "subscription",
      });
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
