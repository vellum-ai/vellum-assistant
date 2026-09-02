/**
 * Tests for `AutoTopUpPaymentMethodModal`: the Stripe element options it
 * mounts, the completeness gate on the primary action, and the state machine
 * around `confirmSetup` (decline, bank confirmation, success, redirect
 * return).
 *
 * Strategy: mock `@stripe/react-stripe-js` with prop-capturing stand-ins
 * (real Stripe Elements need a live iframe) and mock the generated SDK's
 * SetupIntent create so the modal mounts the form synchronously without
 * network.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type ElementProps = {
  onReady?: () => void;
  onChange?: (event: { complete: boolean }) => void;
  onLoadError?: () => void;
  options?: Record<string, unknown>;
};

let paymentElementProps: ElementProps | null = null;
let addressElementProps: ElementProps | null = null;
let elementsProps: { options?: Record<string, unknown> } | null = null;
let confirmSetupCalls: Record<string, unknown>[] = [];
let confirmSetupResult: Promise<Record<string, unknown>> = Promise.resolve({});

const fakeElements = { __tag: "fake-elements" };
const fakeStripe = {
  confirmSetup: (opts: Record<string, unknown>) => {
    confirmSetupCalls.push(opts);
    return confirmSetupResult;
  },
};

mock.module("@stripe/react-stripe-js", () => ({
  Elements: (props: {
    children: ReactNode;
    options?: Record<string, unknown>;
  }) => {
    elementsProps = props;
    return props.children;
  },
  PaymentElement: (props: ElementProps) => {
    paymentElementProps = props;
    return <div />;
  },
  AddressElement: (props: ElementProps) => {
    addressElementProps = props;
    return <div data-testid="stripe-address-element" />;
  },
  useStripe: () => fakeStripe,
  useElements: () => fakeElements,
}));

// Keep `loadStripe` from injecting Stripe.js script tags into happy-dom.
mock.module("@stripe/stripe-js", () => ({
  loadStripe: () => Promise.resolve(null),
}));

import { STRIPE_FONTS } from "@/domains/settings/billing/stripe-appearance";
import type { SavedPaymentMethod } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import * as sdkGen from "@/generated/api/sdk.gen";
import type { AutoTopUpPaymentMethodModalProps } from "./auto-top-up-payment-method-modal";
import * as platformDetection from "@/runtime/platform-detection";
import * as runtimeBrowser from "@/runtime/browser";

let setupIntentCalls = 0;
let setupIntentFails = false;
mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpSetupIntentCreate: () => {
    setupIntentCalls += 1;
    if (setupIntentFails) {
      return Promise.reject(new Error("setup intent unavailable"));
    }
    return Promise.resolve({
      data: { client_secret: `seti_123_secret_${setupIntentCalls}` },
      response: { ok: true },
    });
  },
}));

let nativeAndroid = false;
mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  useIsNativeAndroid: () => nativeAndroid,
}));

let openedUrl: string | null = null;
mock.module("@/runtime/browser", () => ({
  ...runtimeBrowser,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

// The modal reads VITE_STRIPE_PUBLISHABLE_KEY into module-scope `STRIPE_PK`
// at evaluation time (import.meta.env is process.env under Bun); without it
// the modal renders only the missing-key notice. Static imports are hoisted
// ahead of this assignment, so the component must be imported dynamically
// after the env var is set.
const originalStripePk = process.env.VITE_STRIPE_PUBLISHABLE_KEY;
process.env.VITE_STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
const { useAuthStore } = await import("@/stores/auth-store");
const {
  AutoTopUpPaymentMethodModal,
  CUSTOM_TERMS_APPROVED,
  REQUIRES_ACTION_HINT_MS,
  SAVED_AUTO_CLOSE_MS,
} = await import("./auto-top-up-payment-method-modal");

const initialAuthState = useAuthStore.getState();

// `bun test` runs all test files in one process, so restore the env var to
// avoid leaking it into other test files.
afterAll(() => {
  if (originalStripePk === undefined) {
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
  } else {
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = originalStripePk;
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function seedUser(email: string | null): void {
  useAuthStore.setState({
    user: {
      kind: "platform",
      id: "user-123",
      username: null,
      email,
      isStaff: false,
      firstName: "Ada",
      lastName: "L",
    },
  });
}

function renderModal(
  props: Partial<AutoTopUpPaymentMethodModalProps> = {},
): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AutoTopUpPaymentMethodModal
        open
        onClose={() => {}}
        onSavedOptimistic={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

/** Wait for the SetupIntent mutation to resolve and the card form to mount. */
async function renderModalWithForm(
  props: Partial<AutoTopUpPaymentMethodModalProps> = {},
): Promise<ReturnType<typeof render>> {
  const result = renderModal(props);
  await result.findByTestId("stripe-address-element");
  return result;
}

/** Mount both elements and mark both complete so the primary action enables. */
async function renderReadyForm(
  props: Partial<AutoTopUpPaymentMethodModalProps> = {},
): Promise<ReturnType<typeof render>> {
  const result = await renderModalWithForm(props);
  fireOnReady(paymentElementProps);
  fireOnReady(addressElementProps);
  fireOnChange(paymentElementProps, { complete: true });
  fireOnChange(addressElementProps, { complete: true });
  return result;
}

function fireOnReady(props: ElementProps | null): void {
  if (!props?.onReady) {
    throw new Error("expected an onReady handler");
  }
  act(() => props.onReady!());
}

function fireOnChange(
  props: ElementProps | null,
  event: { complete: boolean },
): void {
  if (!props?.onChange) {
    throw new Error("expected an onChange handler");
  }
  act(() => props.onChange!(event));
}

function fireOnLoadError(props: ElementProps | null): void {
  if (!props?.onLoadError) {
    throw new Error("expected an onLoadError handler");
  }
  act(() => props.onLoadError!());
}

function saveButton(result: ReturnType<typeof render>): HTMLButtonElement {
  return result.getByTestId("auto-top-up-pm-save-button") as HTMLButtonElement;
}

beforeEach(() => {
  paymentElementProps = null;
  addressElementProps = null;
  elementsProps = null;
  confirmSetupCalls = [];
  confirmSetupResult = Promise.resolve({});
  setupIntentCalls = 0;
  setupIntentFails = false;
  nativeAndroid = false;
  openedUrl = null;
  useAuthStore.setState(initialAuthState, true);
  seedUser("user@example.com");
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoTopUpPaymentMethodModal on native Android", () => {
  test("opens the web billing page and closes instead of mounting Stripe Elements", async () => {
    nativeAndroid = true;
    const closes: number[] = [];
    const { queryByTestId } = renderModal({ onClose: () => closes.push(1) });

    await waitFor(() =>
      expect(openedUrl).toBe(
        `${window.location.origin}/assistant/settings/usage?tab=billing`,
      ),
    );
    expect(closes.length).toBe(1);
    expect(queryByTestId("stripe-address-element")).toBeNull();
  });
});

describe("AutoTopUpPaymentMethodModal Stripe element options", () => {
  test("mounts a billing-mode AddressElement with autocomplete and the account name", async () => {
    await renderModalWithForm();

    expect(addressElementProps?.options?.mode).toBe("billing");
    expect(addressElementProps?.options?.autocomplete).toEqual({
      mode: "automatic",
    });
    expect(addressElementProps?.options?.fields).toEqual({ phone: "never" });
    expect(addressElementProps?.options?.defaultValues).toEqual({
      name: "Ada L",
      address: undefined,
    });
  });

  test("seeds the AddressElement from a saved billing address", async () => {
    await renderModalWithForm({
      billingAddress: {
        line1: "1 Example St",
        line2: null,
        city: "Springfield",
        state: "CA",
        postal_code: "90001",
        country: "US",
      },
    });

    expect(
      (addressElementProps?.options?.defaultValues as Record<string, unknown>)
        .address,
    ).toEqual({
      country: "US",
      line1: "1 Example St",
      line2: undefined,
      city: "Springfield",
      state: "CA",
      postal_code: "90001",
    });
  });

  test("offers Link, suppresses the other wallets, and asks for no email when the account has one", async () => {
    await renderModalWithForm();

    expect(paymentElementProps?.options?.wallets).toEqual({
      link: "auto",
      applePay: "never",
      googlePay: "never",
    });
    expect(paymentElementProps?.options?.fields).toEqual({
      billingDetails: { name: "never", address: "never", email: "never" },
    });
    expect(paymentElementProps?.options?.paymentMethodOrder).toBeUndefined();
    // A Link member's default email would mount an OTP takeover ahead of the
    // card fields.
    expect(paymentElementProps?.options?.defaultValues).toBeUndefined();
  });

  test("asks for the email when the account does not know it", async () => {
    seedUser(null);
    await renderModalWithForm();

    expect(paymentElementProps?.options?.fields).toEqual({
      billingDetails: { name: "never", address: "never", email: "auto" },
    });
  });

  test("leaves Stripe's own card mandate on while the custom terms wait on legal", async () => {
    await renderModalWithForm();

    expect(CUSTOM_TERMS_APPROVED).toBe(false);
    expect(paymentElementProps?.options?.terms).toEqual({ card: "auto" });
  });

  test("themes Elements from the shared token-driven appearance builder", async () => {
    await renderModalWithForm();

    const options = elementsProps?.options as
      { appearance?: Record<string, unknown>; fonts?: unknown } | undefined;
    expect(options?.appearance?.labels).toBe("floating");
    expect(options?.fonts).toEqual(STRIPE_FONTS);
  });

  test("re-themes Elements when the document theme flips to dark", async () => {
    await renderReadyForm();
    const baseTheme = () =>
      (
        elementsProps?.options as
          { appearance?: { theme?: string } } | undefined
      )?.appearance?.theme;
    expect(baseTheme()).toBe("stripe");

    const previous = document.documentElement.getAttribute("data-theme");
    try {
      act(() => {
        document.documentElement.setAttribute("data-theme", "dark");
      });
      // happy-dom holds a MutationObserver callback behind a WeakRef, so the
      // theme hook's subscription can be collected mid-test. Any re-render
      // re-reads the attribute, so drive one rather than wait on the observer.
      fireOnChange(addressElementProps, { complete: false });
      expect(baseTheme()).toBe("night");
    } finally {
      if (previous === null) {
        document.documentElement.removeAttribute("data-theme");
      } else {
        document.documentElement.setAttribute("data-theme", previous);
      }
    }
  });
});

describe("AutoTopUpPaymentMethodModal completeness gate", () => {
  test("keeps the primary action disabled until both elements are ready AND complete", async () => {
    const result = await renderModalWithForm();
    expect(saveButton(result).disabled).toBe(true);

    fireOnReady(paymentElementProps);
    fireOnReady(addressElementProps);
    expect(saveButton(result).disabled).toBe(true);

    fireOnChange(paymentElementProps, { complete: true });
    expect(saveButton(result).disabled).toBe(true);

    fireOnChange(addressElementProps, { complete: true });
    expect(saveButton(result).disabled).toBe(false);

    fireOnChange(addressElementProps, { complete: false });
    expect(saveButton(result).disabled).toBe(true);
  });

  test("re-disables the primary action when an element fails to load", async () => {
    const result = await renderReadyForm();
    expect(saveButton(result).disabled).toBe(false);

    // The form unmounts with the failed element, so it cannot report its own
    // completeness back down; the error branch has to do it.
    fireOnLoadError(addressElementProps);
    expect(saveButton(result).disabled).toBe(true);
  });
});

describe("AutoTopUpPaymentMethodModal submit", () => {
  test("confirms the SetupIntent with the elements and the known email", async () => {
    const result = await renderReadyForm();

    fireEvent.click(saveButton(result));

    await waitFor(() => {
      if (confirmSetupCalls.length === 0) {
        throw new Error("confirmSetup not called");
      }
    });
    expect(confirmSetupCalls).toHaveLength(1);
    const call = confirmSetupCalls[0]!;
    // Address value flows via `elements`; no manual billing address plumbing.
    expect(call.elements).toBe(fakeElements);
    expect(call.redirect).toBe("if_required");
    const confirmParams = call.confirmParams as Record<string, unknown>;
    expect(confirmParams.return_url).toBeDefined();
    expect(confirmParams.payment_method_data).toEqual({
      billing_details: { email: "user@example.com" },
    });
  });

  test("omits payment_method_data when the account has no email", async () => {
    seedUser(null);
    const result = await renderReadyForm();

    fireEvent.click(saveButton(result));

    await waitFor(() => {
      if (confirmSetupCalls.length === 0) {
        throw new Error("confirmSetup not called");
      }
    });
    expect(
      (confirmSetupCalls[0]!.confirmParams as Record<string, unknown>)
        .payment_method_data,
    ).toBeUndefined();
  });

  test("reports the SetupIntent id derived from the client secret on save", async () => {
    const savedArgs: Array<{ setupIntentId: string | null }> = [];
    const result = await renderReadyForm({
      onSavedOptimistic: (args) => {
        savedArgs.push(args);
      },
    });

    fireEvent.click(saveButton(result));

    await waitFor(() => {
      if (savedArgs.length === 0) {
        throw new Error("onSavedOptimistic not called");
      }
    });
    // The mocked client_secret is `seti_123_secret_<call number>`.
    expect(savedArgs[0]).toEqual({ setupIntentId: "seti_123" });
  });

  test("a decline shows the decline copy and re-enables the form", async () => {
    confirmSetupResult = Promise.resolve({
      error: { code: "card_declined", message: "Generic decline." },
    });
    const result = await renderReadyForm();

    fireEvent.click(saveButton(result));

    await waitFor(() =>
      expect(
        result.getByTestId("auto-top-up-pm-modal-confirm-error").textContent,
      ).toContain("Your bank declined this card."),
    );
    expect(saveButton(result).disabled).toBe(false);
  });

  test("a non-decline failure surfaces the Stripe message", async () => {
    confirmSetupResult = Promise.resolve({
      error: { code: "processing_error", message: "Something went wrong." },
    });
    const result = await renderReadyForm();

    fireEvent.click(saveButton(result));

    await waitFor(() =>
      expect(
        result.getByTestId("auto-top-up-pm-modal-confirm-error").textContent,
      ).toContain("Something went wrong."),
    );
  });

  test("a rejected confirm unlocks the modal into a generic error state", async () => {
    let rejectConfirm: (reason: unknown) => void = () => {};
    confirmSetupResult = new Promise((_resolve, reject) => {
      rejectConfirm = reject;
    });
    const closes: number[] = [];
    const result = await renderReadyForm({ onClose: () => closes.push(1) });

    fireEvent.click(saveButton(result));

    await waitFor(() => {
      if (confirmSetupCalls.length === 0) {
        throw new Error("confirmSetup not called");
      }
    });

    await act(async () => {
      rejectConfirm(new Error("stripe.js exploded"));
      await confirmSetupResult.catch(() => {});
    });

    await waitFor(() => {
      const line = result.getByTestId("auto-top-up-pm-modal-confirm-error");
      expect(line.textContent).toContain("Failed to save payment method.");
      expect(line.textContent).not.toContain("stripe.js exploded");
    });
    expect(saveButton(result).disabled).toBe(false);
    expect(
      (result.getByTestId("payment-method-modal-close") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() => expect(closes).toHaveLength(1));
  });

  test("a rejected saved-card sync also lands in the unlocked error state", async () => {
    const result = await renderReadyForm({
      onSavedOptimistic: () => Promise.reject(new Error("sync failed")),
    });

    fireEvent.click(saveButton(result));

    await waitFor(() =>
      expect(
        result.getByTestId("auto-top-up-pm-modal-confirm-error").textContent,
      ).toContain("Failed to save payment method."),
    );
    expect(result.queryByTestId("payment-method-modal-saved")).toBeNull();
    expect(saveButton(result).disabled).toBe(false);
  });

  test("a slow confirm shows the bank status row and locks the modal shut", async () => {
    let settle: (value: Record<string, unknown>) => void = () => {};
    confirmSetupResult = new Promise((resolve) => {
      settle = resolve;
    });
    const closes: number[] = [];
    const result = await renderReadyForm({ onClose: () => closes.push(1) });

    fireEvent.click(saveButton(result));

    await waitFor(
      () =>
        expect(
          result.getByTestId("payment-method-modal-status-row").textContent,
        ).toContain("Confirming with your bank"),
      { timeout: 4000 },
    );

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(closes).toHaveLength(0);
    expect(
      (result.getByTestId("payment-method-modal-close") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      settle({ error: { code: "processing_error", message: "Timed out." } });
      await confirmSetupResult;
    });
  });

  test("success shows the saved panel and closes after the auto-close delay", async () => {
    const closes: number[] = [];
    const result = await renderReadyForm({
      onClose: () => closes.push(1),
      onSavedOptimistic: () =>
        Promise.resolve({
          brand: "visa",
          last4: "4242",
          autoReloadEnabled: true,
        }),
    });

    fireEvent.click(saveButton(result));

    await waitFor(() => {
      const panel = result.getByTestId("payment-method-modal-saved");
      expect(panel.textContent).toContain("Visa •••• 4242 saved");
      expect(panel.textContent).toContain("Auto-reload is active again");
    });
    expect(closes).toHaveLength(0);

    await waitFor(() => expect(closes).toHaveLength(1), { timeout: 3000 });
  });

  test("a slow saved-card sync never flips the modal to the bank hint", async () => {
    let resolveSync: (card: SavedPaymentMethod | null) => void = () => {};
    const syncPromise = new Promise<SavedPaymentMethod | null>((resolve) => {
      resolveSync = resolve;
    });
    const result = await renderReadyForm({
      onSavedOptimistic: () => syncPromise,
    });

    fireEvent.click(saveButton(result));

    await waitFor(() => {
      if (confirmSetupCalls.length === 0) {
        throw new Error("confirmSetup not called");
      }
    });

    // The confirm has already resolved, so the hint must stay disarmed even
    // though the sync outlives it.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, REQUIRES_ACTION_HINT_MS + 500);
      });
    });

    expect(result.queryByTestId("payment-method-modal-status-row")).toBeNull();
    expect(result.queryByTestId("payment-method-modal-saved")).toBeNull();
    expect(saveButton(result).textContent).toContain("Saving");

    await act(async () => {
      resolveSync({ brand: "visa", last4: "4242", autoReloadEnabled: false });
      await syncPromise;
    });

    await waitFor(() =>
      expect(
        result.getByTestId("payment-method-modal-saved").textContent,
      ).toContain("Visa •••• 4242 saved"),
    );
  });
});

describe("AutoTopUpPaymentMethodModal field skeleton", () => {
  test("opens on the field skeleton rather than a spinner", async () => {
    const result = renderModal();

    const skeleton = result.getByTestId("auto-top-up-pm-modal-skeleton");
    // The modal is its own surface, so this skeleton keeps the labelled
    // loading region the billing cards' presentational ones gave up.
    expect(skeleton.getAttribute("role")).toBe("status");
    expect(skeleton.getAttribute("aria-label")).toBe("Loading payment fields");
    expect(result.queryByTestId("auto-top-up-pm-modal-spinner")).toBeNull();
    expect(result.queryByTestId("stripe-address-element")).toBeNull();

    await result.findByTestId("stripe-address-element");
    // The same skeleton spans both waits, so the shimmer does not restart
    // when the SetupIntent lands.
    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).toBe(skeleton);
  });

  test("suppresses Stripe's own loader so ours is the only one", async () => {
    await renderModalWithForm();

    expect((elementsProps?.options as Record<string, unknown>).loader).toBe(
      "never",
    );
  });

  test("holds the skeleton until both elements are ready, then reveals the fields", async () => {
    const result = await renderModalWithForm();
    const addressElement = result.getByTestId("stripe-address-element");
    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).not.toBeNull();

    fireOnReady(paymentElementProps);
    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).not.toBeNull();

    fireOnReady(addressElementProps);
    expect(result.queryByTestId("auto-top-up-pm-modal-skeleton")).toBeNull();
    // The reveal must not tear the elements down and boot them again.
    expect(result.getByTestId("stripe-address-element")).toBe(addressElement);
  });

  test("the skeleton and the mounted form share one field-stack rhythm", async () => {
    // They stand in for each other, so the two must keep the same spacing or
    // the reveal changes the modal's height.
    const result = await renderModalWithForm();

    const skeleton = result.getByTestId("auto-top-up-pm-modal-skeleton");
    const form = result.getByTestId("stripe-address-element").parentElement;
    expect(skeleton.className).toContain("gap-[10px]");
    expect(form?.className).toContain("gap-[10px]");
  });

  test("a re-open goes back to the skeleton until the new fields are ready", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const tree = (open: boolean) => (
      <QueryClientProvider client={client}>
        <AutoTopUpPaymentMethodModal
          open={open}
          onClose={() => {}}
          onSavedOptimistic={() => {}}
        />
      </QueryClientProvider>
    );
    const result = render(tree(true));
    await result.findByTestId("stripe-address-element");
    fireOnReady(paymentElementProps);
    fireOnReady(addressElementProps);
    expect(result.queryByTestId("auto-top-up-pm-modal-skeleton")).toBeNull();

    result.rerender(tree(false));
    result.rerender(tree(true));

    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).not.toBeNull();
    // The second SetupIntent lands on a new client secret with the elements
    // still booting, so the readiness from the first open must not have
    // carried over.
    await result.findByTestId("stripe-address-element");
    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).not.toBeNull();

    // The re-mounted form reports readiness again, so the reset the re-open
    // made is answered rather than left holding the skeleton forever.
    fireOnReady(paymentElementProps);
    fireOnReady(addressElementProps);
    expect(result.queryByTestId("auto-top-up-pm-modal-skeleton")).toBeNull();
  });

  test("an element load failure swaps the skeleton for a retryable error", async () => {
    const result = await renderModalWithForm();
    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).not.toBeNull();

    fireOnLoadError(paymentElementProps);

    // A failed element never reports ready, so the surface has to settle
    // here rather than wait on a readiness that is not coming.
    expect(
      result.getByTestId("auto-top-up-pm-modal-fields-error").textContent,
    ).toContain("Failed to load the payment form");
    expect(result.queryByTestId("auto-top-up-pm-modal-skeleton")).toBeNull();
    expect(result.queryByTestId("stripe-address-element")).toBeNull();
    // The message has one home: the shell's inline error line stays empty.
    expect(
      result.queryByTestId("auto-top-up-pm-modal-confirm-error"),
    ).toBeNull();

    fireEvent.click(result.getByText("Try again"));

    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).not.toBeNull();
    await result.findByTestId("stripe-address-element");
    expect(setupIntentCalls).toBe(2);
  });

  test("an address element load failure settles the same surface", async () => {
    const result = await renderModalWithForm();

    fireOnLoadError(addressElementProps);

    expect(
      result.getByTestId("auto-top-up-pm-modal-fields-error").textContent,
    ).toContain("Failed to load the billing address form");
    expect(result.queryByTestId("auto-top-up-pm-modal-skeleton")).toBeNull();
  });

  test("a re-open after a load failure comes back on the skeleton", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const tree = (open: boolean) => (
      <QueryClientProvider client={client}>
        <AutoTopUpPaymentMethodModal
          open={open}
          onClose={() => {}}
          onSavedOptimistic={() => {}}
        />
      </QueryClientProvider>
    );
    const result = render(tree(true));
    await result.findByTestId("stripe-address-element");
    fireOnLoadError(paymentElementProps);
    expect(
      result.getByTestId("auto-top-up-pm-modal-fields-error"),
    ).not.toBeNull();

    result.rerender(tree(false));
    result.rerender(tree(true));

    expect(
      result.queryByTestId("auto-top-up-pm-modal-fields-error"),
    ).toBeNull();
    expect(result.getByTestId("auto-top-up-pm-modal-skeleton")).not.toBeNull();
    await result.findByTestId("stripe-address-element");
  });

  test("a failed SetupIntent swaps the skeleton for the retry action", async () => {
    setupIntentFails = true;
    const result = renderModal();

    const notice = await result.findByTestId("auto-top-up-pm-modal-error");
    expect(notice.textContent).toContain("Failed to start card setup");
    expect(result.queryByTestId("auto-top-up-pm-modal-skeleton")).toBeNull();

    setupIntentFails = false;
    fireEvent.click(result.getByText("Try again"));

    await result.findByTestId("stripe-address-element");
    expect(setupIntentCalls).toBe(2);
  });
});

describe("AutoTopUpPaymentMethodModal redirect return", () => {
  test("a saved outcome renders the panel without creating a SetupIntent", async () => {
    const { getByTestId, queryByTestId } = renderModal({
      initialOutcome: {
        kind: "saved",
        card: { brand: "visa", last4: "1881", autoReloadEnabled: false },
      },
    });

    await waitFor(() =>
      expect(getByTestId("payment-method-modal-saved").textContent).toContain(
        "Visa •••• 1881 saved",
      ),
    );
    expect(setupIntentCalls).toBe(0);
    expect(queryByTestId("stripe-address-element")).toBeNull();
    expect(queryByTestId("auto-top-up-pm-modal-skeleton")).toBeNull();
  });

  test("a saved outcome closes itself on the same auto-close delay", async () => {
    const closes: number[] = [];
    const { getByTestId } = renderModal({
      onClose: () => closes.push(1),
      initialOutcome: {
        kind: "saved",
        card: { brand: "visa", last4: "1881", autoReloadEnabled: false },
      },
    });

    await waitFor(() =>
      expect(getByTestId("payment-method-modal-saved")).not.toBeNull(),
    );
    expect(closes).toHaveLength(0);

    await waitFor(() => expect(closes).toHaveLength(1), {
      timeout: SAVED_AUTO_CLOSE_MS * 4,
    });
  });

  test("an error outcome pre-fills the error line over a fresh SetupIntent", async () => {
    const { getByTestId } = await renderModalWithForm({
      initialOutcome: { kind: "error", message: "Authentication failed." },
    });

    expect(
      getByTestId("auto-top-up-pm-modal-confirm-error").textContent,
    ).toContain("Authentication failed.");
    expect(setupIntentCalls).toBe(1);
  });
});

/**
 * The shell owns the subtitle sentences and is tested on them directly, so
 * these cases cover only what the modal decides: which mode it opens in, and
 * that `cardOnFile` reaches the shell in replace mode.
 */
describe("AutoTopUpPaymentMethodModal modes", () => {
  test("defaults to add mode", async () => {
    const { getByText } = await renderModalWithForm();

    expect(getByText("Add a card")).not.toBeNull();
  });

  test("replace mode hands the card on file to the shell", async () => {
    const { getByText } = await renderModalWithForm({
      mode: "replace",
      cardOnFile: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2042 },
    });

    expect(getByText("Replace your card")).not.toBeNull();
    expect(getByText(/Replacing Visa •••• 4242/)).not.toBeNull();
  });
});
