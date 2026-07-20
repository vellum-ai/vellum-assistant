/**
 * Tests for the pure-props `ProvisioningState` screen. Renders via
 * `@testing-library/react` (happy-dom registered in test-setup.ts); no
 * network mocks — every phase is driven entirely through props.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { ProvisioningStateProps } from "./provisioning-state";
import { ProvisioningState } from "./provisioning-state";

afterEach(() => {
  cleanup();
});

function baseProps(
  overrides: Partial<ProvisioningStateProps> = {},
): ProvisioningStateProps {
  return {
    state: "CONFIRMING",
    softWaiting: false,
    intent: null,
    targets: { machineSize: null, storageGib: null },
    fromSnapshot: { machineSize: null, storageGib: null },
    celebrating: false,
    onCelebrationEnd: () => {},
    escapeAvailable: false,
    onEscape: () => {},
    stalledAction: { onApply: () => {}, pending: false, error: null },
    confirm: { onRetry: () => {}, onGoToBilling: () => {} },
    ...overrides,
  };
}

function renderState(overrides: Partial<ProvisioningStateProps> = {}) {
  return render(<ProvisioningState {...baseProps(overrides)} />);
}

describe("confirming", () => {
  test("renders the payment-confirmed headline with a package chip", () => {
    const { getByText } = renderState({
      state: "CONFIRMING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
    });

    expect(
      getByText("Payment confirmed — setting up your upgrade…"),
    ).toBeTruthy();
    expect(getByText("Mighty package")).toBeTruthy();
  });

  test("renders custom-intent tier chips, omitting the credits chip when null", () => {
    const { getByText, queryByText } = renderState({
      state: "CONFIRMING",
      intent: {
        kind: "custom",
        machineTier: "large",
        storageTier: "xl",
        creditTier: null,
        savedAt: Date.now(),
      },
    });

    expect(getByText("Large machine")).toBeTruthy();
    expect(getByText("XL storage")).toBeTruthy();
    expect(queryByText(/credits/)).toBeNull();
  });

  test("renders a credits chip when the custom intent bundles credits", () => {
    const { getByText } = renderState({
      state: "CONFIRMING",
      intent: {
        kind: "custom",
        machineTier: "medium",
        storageTier: "s",
        creditTier: "credits_50",
        savedAt: Date.now(),
      },
    });

    expect(getByText("50 credits")).toBeTruthy();
  });

});

describe("waiting / resizing", () => {
  test("renders machine and storage cards with the from-snapshot and restart warning", () => {
    const { getByText } = renderState({
      state: "WAITING",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });

    expect(getByText("Setting up your new resources…")).toBeTruthy();
    expect(getByText("Machine")).toBeTruthy();
    expect(getByText("Small")).toBeTruthy();
    expect(getByText("Large")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(getByText("30 GiB")).toBeTruthy();
    expect(getByText("100 GiB")).toBeTruthy();
    expect(
      getByText(
        "Your assistant is restarting itself — it may look offline for a minute.",
      ),
    ).toBeTruthy();
  });

  test("storage-only targets render a single storage card and no machine card", () => {
    const { getByText, queryByText } = renderState({
      state: "RESIZING",
      targets: { machineSize: null, storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });

    expect(getByText("Resizing your assistant…")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(queryByText("Machine")).toBeNull();
  });

  test("softWaiting swaps in the softened sub-copy", () => {
    const { getByText, rerender } = renderState({
      state: "WAITING",
      targets: { machineSize: "medium", storageGib: null },
    });

    expect(getByText("This usually takes under a minute.")).toBeTruthy();

    rerender(
      <ProvisioningState
        {...baseProps({
          state: "WAITING",
          softWaiting: true,
          targets: { machineSize: "medium", storageGib: null },
        })}
      />,
    );
    expect(
      getByText(
        "Still working — this can take a few minutes. Everything is on track.",
      ),
    ).toBeTruthy();
  });
});

describe("done / not_applicable", () => {
  test("done renders the celebration headline and fires onCelebrationEnd after the dwell", async () => {
    const onCelebrationEnd = mock(() => {});
    const { getByText } = renderState({
      state: "DONE",
      celebrating: true,
      onCelebrationEnd,
      dwellMs: 10,
    });

    expect(getByText("Your upgrade is ready")).toBeTruthy();
    await waitFor(() => expect(onCelebrationEnd).toHaveBeenCalledTimes(1));
  });

  test("done does not fire onCelebrationEnd when not celebrating", async () => {
    const onCelebrationEnd = mock(() => {});
    renderState({
      state: "DONE",
      celebrating: false,
      onCelebrationEnd,
      dwellMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onCelebrationEnd).not.toHaveBeenCalled();
  });

  test("not_applicable renders the plan-ready notice without cards or an Apply button", async () => {
    const onCelebrationEnd = mock(() => {});
    const { getByText, queryByText, queryByTestId } = renderState({
      state: "NOT_APPLICABLE",
      celebrating: true,
      onCelebrationEnd,
      dwellMs: 10,
    });

    expect(getByText("Your plan is ready")).toBeTruthy();
    expect(
      getByText("No resource changes were needed — you're all set."),
    ).toBeTruthy();
    expect(queryByText("Machine")).toBeNull();
    expect(queryByTestId("provisioning-apply")).toBeNull();
    await waitFor(() => expect(onCelebrationEnd).toHaveBeenCalledTimes(1));
  });
});

describe("stalled", () => {
  test("renders the amber notice and Apply & Restart invokes the callback", () => {
    const onApply = mock(() => {});
    const { getByText, getByTestId } = renderState({
      state: "STALLED",
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: { machineSize: "small", storageGib: null },
      stalledAction: { onApply, pending: false, error: null },
    });

    expect(
      getByText(
        "We couldn't finish this automatically. Apply the changes below to finish setting up your upgrade.",
      ),
    ).toBeTruthy();
    fireEvent.click(getByTestId("provisioning-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  test("disables the Apply button while pending and renders the extracted error", () => {
    const onApply = mock(() => {});
    const { getByText, getByTestId } = renderState({
      state: "STALLED",
      stalledAction: {
        onApply,
        pending: true,
        error: { detail: "Resize already in progress." },
      },
    });

    expect(getByText("Resize already in progress.")).toBeTruthy();
    const apply = getByTestId("provisioning-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe("confirm_timeout", () => {
  test("renders the payment-safety reassurance with retry and billing actions", () => {
    const onRetry = mock(() => {});
    const onGoToBilling = mock(() => {});
    const { getByText, getByTestId } = renderState({
      state: "CONFIRM_TIMEOUT",
      confirm: { onRetry, onGoToBilling },
    });

    expect(
      getByText(
        "Your payment went through safely — we're still confirming your upgrade with Stripe. This can take a minute.",
      ),
    ).toBeTruthy();
    fireEvent.click(getByTestId("onboarding-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("onboarding-go-to-billing"));
    expect(onGoToBilling).toHaveBeenCalledTimes(1);
  });
});

describe("escape hatch", () => {
  test("renders the background-continue button only when available", () => {
    const onEscape = mock(() => {});
    const { getByTestId } = renderState({
      state: "WAITING",
      targets: { machineSize: "medium", storageGib: null },
      escapeAvailable: true,
      onEscape,
    });

    fireEvent.click(getByTestId("provisioning-escape"));
    expect(onEscape).toHaveBeenCalledTimes(1);

    cleanup();
    const { queryByTestId } = renderState({
      state: "WAITING",
      targets: { machineSize: "medium", storageGib: null },
      escapeAvailable: false,
    });
    expect(queryByTestId("provisioning-escape")).toBeNull();
  });
});
