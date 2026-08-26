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
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { BillingSummaryResponse } from "@/generated/api/types.gen";
import * as sdkGen from "@/generated/api/sdk.gen";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { routes } from "@/utils/routes";
import * as capacitorCore from "@capacitor/core";

let nativeAndroid = false;
// Drives `Capacitor.isNativePlatform()`, which `checkoutReturnTarget()` reads
// to pick the custom-scheme return on the Capacitor shells.
let nativePlatform = false;

type Captured = { body?: unknown };
const checkoutCalls: Captured[] = [];

const SUMMARY: BillingSummaryResponse = {
  settled_balance: "20.00",
  minimum_top_up: "5.00",
  maximum_top_up: "100.00",
  maximum_balance: "500.00",
  allowed_top_up_amounts: ["5.00", "10.00", "25.00"],
  settled_balance_usd: "20.00",
  minimum_top_up_usd: "5.00",
  maximum_top_up_usd: "100.00",
  maximum_balance_usd: "500.00",
  pending_compute: "0.00",
  pending_compute_usd: "0.00",
  effective_balance: "20.00",
  effective_balance_usd: "20.00",
  is_degraded: false,
  daily_credit_limit_usd: null,
  daily_spend_usd: "0.00",
  daily_limit_reached: false,
  daily_limit_snoozed: false,
  low_balance_threshold_usd: "5.00",
  low_balance_warning: false,
  credits_expiring_soon_usd: "0.00",
  next_credit_expiry_at: null,
};

// Captures the modal's `browserFinished` subscriber so a test can fire the
// Capacitor sheet-dismissal signal on demand.
let browserFinishedCallback: (() => void) | null = null;
let openedUrl: string | null = null;
mock.module("@/runtime/browser", () => ({
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
  openUrlFinishedListener: (callback: () => void) => {
    browserFinishedCallback = callback;
    return () => {
      browserFinishedCallback = null;
    };
  },
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
  // Mirrors the real implementation: reads the window bridge, and a legacy
  // bridge without hostOS is a macOS host.
  detectElectronHostOS: () => {
    const vellum = (
      window as { vellum?: { platform?: string; hostOS?: string } }
    ).vellum;
    if (vellum?.platform !== "electron") {
      return null;
    }
    return vellum.hostOS ?? "macos";
  },
}));

mock.module("@capacitor/core", () => ({
  ...capacitorCore,
  Capacitor: {
    ...capacitorCore.Capacitor,
    isNativePlatform: () => nativePlatform,
  },
}));

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSummaryRetrieve: () =>
    Promise.resolve({ data: SUMMARY, response: { ok: true } }),
  organizationsBillingTopUpsCheckoutSessionCreate: (opts: Captured) => {
    checkoutCalls.push(opts);
    return Promise.resolve({
      data: {
        billing_top_up_id: "top-up-123",
        checkout_url: "https://stripe.test/checkout/session",
        requested_amount: "5.00",
        requested_amount_usd: "5.00",
      },
      response: { ok: true },
    });
  },
}));

const { AddCreditsModal } = await import("@/components/add-credits-modal");

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  nativeAndroid = false;
  nativePlatform = false;
  openedUrl = null;
  delete (window as { vellum?: unknown }).vellum;
  checkoutCalls.length = 0;
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
  test("native Android opens the web billing page and closes instead of rendering", async () => {
    nativeAndroid = true;
    const closes: boolean[] = [];
    renderModal((open) => closes.push(open));

    await waitFor(() =>
      expect(openedUrl).toBe(
        new URL(
          routes.settings.usageBilling,
          window.location.origin,
        ).toString(),
      ),
    );
    expect(closes).toEqual([false]);
    expect(screen.queryByText("Add Credits")).toBeNull();
    expect(checkoutCalls.length).toBe(0);
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
      name: /Configure Auto-Reload/,
    });
    expect(link.getAttribute("href")).toBe(
      routes.settings.usageBillingConfigureTopUps,
    );
  });
});

describe("AddCreditsModal checkout return_target", () => {
  // The platform uses `return_target` to decide whether checkout finishes on
  // a web return URL or the custom-scheme bounce. Dropping it from the body
  // silently strands Electron/iOS users in the external browser, so these
  // tests pin the pass-through of `checkoutReturnTarget()`.

  async function submitCheckout(): Promise<Captured> {
    renderModal();

    const button = screen.getByRole("button", {
      name: "Continue",
    }) as HTMLButtonElement;
    // Enabled only once the billing summary has loaded.
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(checkoutCalls.length).toBe(1));
    return checkoutCalls[0]!;
  }

  test('sends return_target "web" in a plain browser', async () => {
    const call = await submitCheckout();

    expect(call.body).toMatchObject({
      amount: "5.00",
      return_target: "web",
    });
  });

  test('sends return_target "native" on a Capacitor shell', async () => {
    nativePlatform = true;

    const call = await submitCheckout();

    expect(call.body).toMatchObject({ return_target: "native" });
  });

  test('sends return_target "native" inside the Electron shell', async () => {
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    const call = await submitCheckout();

    expect(call.body).toMatchObject({ return_target: "native" });
  });

  test('sends return_target "web" on the Windows Electron shell', async () => {
    // The Windows preload stubs deepLinks, so a native bounce would land on a
    // custom-scheme URL nothing consumes.
    (window as { vellum?: unknown }).vellum = {
      platform: "electron",
      hostOS: "windows",
    };

    const call = await submitCheckout();

    expect(call.body).toMatchObject({ return_target: "web" });
  });
});

describe("AddCreditsModal checkout-complete deep-link cleanup", () => {
  // On Electron the Capacitor `browserFinished` listener never fires, so
  // the `flow=top_up` checkout-complete deep link is the only signal that
  // the system-browser checkout is over. The modal must dismiss itself on
  // it (both outcomes) so it does not sit over the success toast or the
  // billing page's cancel-triggered bonus-offer flow. Closing is ALL it
  // does: the success toast and the billing-summary invalidation are owned
  // by `useGlobalDeepLinkConsumer` via `notifyCheckoutSuccess`.

  test("closes on a top_up success return without invalidating the summary itself", () => {
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
    expect(invalidateSpy).not.toHaveBeenCalled();
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

describe("AddCreditsModal browserFinished cleanup", () => {
  // The Capacitor sheet-dismissal signal carries no success/cancel meaning:
  // completed outcomes (and their summary refetch) arrive via the `flow=top_up`
  // deep link, so `browserFinished` is close-only. Invalidating here too would
  // double the refetch on an iOS success and waste one on an abandoned sheet.

  test("closes the modal without invalidating the summary", () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const { client } = renderModal(onOpenChange);
    const invalidateSpy = spyOn(client, "invalidateQueries");
    expect(browserFinishedCallback).not.toBeNull();

    act(() => {
      browserFinishedCallback?.();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
