import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  isLockedState,
  PaymentMethodModalShell,
  type PaymentMethodModalShellProps,
} from "./payment-method-modal-shell";

afterEach(cleanup);

function renderShell(overrides: Partial<PaymentMethodModalShellProps> = {}) {
  return render(
    <PaymentMethodModalShell
      open
      mode="add"
      state="idle"
      onClose={() => {}}
      {...overrides}
    >
      <div data-testid="field-block" />
    </PaymentMethodModalShell>,
  );
}

const VISA_ON_FILE = {
  brand: "visa",
  last4: "4242",
  expMonth: 4,
  expYear: 2042,
};

describe("PaymentMethodModalShell", () => {
  test("add mode titles the modal and the primary action", () => {
    const { getByText, getByTestId, queryByTestId } = renderShell();
    expect(getByText("Add a card")).not.toBeNull();
    expect(
      getByText("Kept on file for auto-reload and your Pro plan."),
    ).not.toBeNull();
    expect(getByTestId("auto-top-up-pm-save-button").textContent).toBe(
      "Save card",
    );
    expect(queryByTestId("payment-method-modal-card-on-file")).toBeNull();
  });

  test("replace mode titles the modal and shows the card on file", () => {
    const { getByText, getByTestId } = renderShell({
      mode: "replace",
      cardOnFile: VISA_ON_FILE,
    });
    expect(getByText("Replace your card")).not.toBeNull();
    expect(getByTestId("auto-top-up-pm-save-button").textContent).toBe(
      "Replace card",
    );
    const row = getByTestId("payment-method-modal-card-on-file");
    expect(row.textContent).toContain("Visa •••• 4242");
    expect(row.textContent).toContain("· 04 / 42");
    expect(row.textContent).toContain("Replaced on save");
  });

  test("omits the expiry when either half is missing", () => {
    const { getByTestId } = renderShell({
      mode: "replace",
      cardOnFile: { ...VISA_ON_FILE, expMonth: null, expYear: null },
    });
    const row = getByTestId("payment-method-modal-card-on-file");
    expect(row.textContent).toContain("Visa •••• 4242");
    expect(row.textContent).not.toContain("·");
    expect(row.textContent).not.toContain("null");
  });

  test("renders the card on file only in replace mode", () => {
    const { queryByTestId } = renderShell({ cardOnFile: VISA_ON_FILE });
    expect(queryByTestId("payment-method-modal-card-on-file")).toBeNull();
  });

  test("showTerms toggles the terms line", () => {
    const { queryByTestId, rerender, getByTestId } = renderShell();
    expect(queryByTestId("payment-method-modal-terms")).toBeNull();

    rerender(
      <PaymentMethodModalShell
        open
        mode="add"
        state="idle"
        showTerms
        onClose={() => {}}
      >
        <div data-testid="field-block" />
      </PaymentMethodModalShell>,
    );
    expect(getByTestId("payment-method-modal-terms").textContent).toContain(
      "Vellum can charge this card",
    );
  });

  test("requires_action shows the bank status row instead of the terms", () => {
    const { getByTestId, queryByTestId } = renderShell({
      state: "requires_action",
      showTerms: true,
    });
    expect(
      getByTestId("payment-method-modal-status-row").textContent,
    ).toContain("Confirming with your bank");
    expect(queryByTestId("payment-method-modal-terms")).toBeNull();
  });

  test("saved shows the success panel with the card and no cancel action", () => {
    const { getByTestId, queryByText } = renderShell({
      state: "saved",
      savedCard: { brand: "visa", last4: "1881" },
      autoReloadActive: true,
    });
    const panel = getByTestId("payment-method-modal-saved");
    expect(panel.textContent).toContain("Visa •••• 1881 saved");
    expect(panel.textContent).toContain("Auto-reload is active again");
    expect(queryByText("Cancel")).toBeNull();
    expect(
      (getByTestId("auto-top-up-pm-save-button") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("saved falls back to the generic title and hides the sub-line", () => {
    const { getByTestId } = renderShell({
      state: "saved",
      savedCard: { brand: null, last4: null },
    });
    const panel = getByTestId("payment-method-modal-saved");
    expect(panel.textContent).toContain("Card saved");
    expect(panel.textContent).not.toContain("Auto-reload is active again");
  });

  test("error renders the message beside a dot", () => {
    const { getByTestId } = renderShell({
      state: "error",
      errorMessage: "Your bank declined this card.",
    });
    const error = getByTestId("auto-top-up-pm-modal-confirm-error");
    expect(error.textContent).toContain("Your bank declined this card.");
    expect(
      error.querySelector(".bg-\\[var\\(--system-negative-strong\\)\\]"),
    ).not.toBeNull();
  });

  test("isLockedState covers only the in-flight states", () => {
    expect(isLockedState("idle")).toBe(false);
    expect(isLockedState("submitting")).toBe(true);
    expect(isLockedState("requires_action")).toBe(true);
    expect(isLockedState("error")).toBe(false);
    expect(isLockedState("saved")).toBe(false);
  });

  test("a locked state disables the dismiss affordances and busies the fields", () => {
    const { getByTestId, getByText } = renderShell({ state: "submitting" });
    expect(
      (getByTestId("payment-method-modal-close") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (getByText("Cancel").closest("button") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      getByTestId("payment-method-modal-fields").getAttribute("aria-busy"),
    ).toBe("true");
    expect(getByTestId("auto-top-up-pm-save-button").textContent).toContain(
      "Saving",
    );
  });

  test("Escape does not close a locked modal but closes an idle one", () => {
    const onClose = mock(() => {});
    const locked = renderShell({ state: "submitting", onClose });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
    locked.unmount();

    renderShell({ state: "idle", onClose });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("cancel closes the modal", () => {
    const onClose = mock(() => {});
    const { getByText } = renderShell({ onClose });
    fireEvent.click(getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking save submits the form and calls onSubmit", () => {
    const onSubmit = mock(() => {});
    const { getByTestId } = renderShell({ onSubmit });
    fireEvent.click(getByTestId("auto-top-up-pm-save-button"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("submitDisabled blocks the primary action", () => {
    const onSubmit = mock(() => {});
    const { getByTestId } = renderShell({ onSubmit, submitDisabled: true });
    const save = getByTestId("auto-top-up-pm-save-button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
