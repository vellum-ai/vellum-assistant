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
    const { getByText, getByTestId } = renderShell();
    expect(getByText("Add a card")).not.toBeNull();
    expect(
      getByText("Kept on file for auto-reload and your Pro plan."),
    ).not.toBeNull();
    expect(getByTestId("auto-top-up-pm-save-button").textContent).toBe(
      "Save card",
    );
  });

  test("replace mode folds the card being replaced into the subtitle", () => {
    const { getByText, getByTestId } = renderShell({
      mode: "replace",
      cardOnFile: VISA_ON_FILE,
    });
    expect(getByText("Replace your card")).not.toBeNull();
    expect(getByTestId("auto-top-up-pm-save-button").textContent).toBe(
      "Replace card",
    );
    expect(
      getByText(
        "Replacing Visa •••• 4242 · 04 / 42. The new card takes over immediately.",
      ),
    ).not.toBeNull();
  });

  test("a card on file with no last4 reads its own sentence", () => {
    const { getByText } = renderShell({
      mode: "replace",
      cardOnFile: { ...VISA_ON_FILE, last4: null },
    });
    expect(
      getByText(
        "Replacing your Visa card · 04 / 42. The new card takes over immediately.",
      ),
    ).not.toBeNull();
  });

  test("a card on file with no brand reads its own sentence", () => {
    const { getByText } = renderShell({
      mode: "replace",
      cardOnFile: { ...VISA_ON_FILE, brand: null },
    });
    expect(
      getByText(
        "Replacing the card ending in 4242 · 04 / 42. The new card takes over immediately.",
      ),
    ).not.toBeNull();
  });

  test("omits the expiry when either half is missing", () => {
    const { getByText } = renderShell({
      mode: "replace",
      cardOnFile: { ...VISA_ON_FILE, expMonth: null, expYear: null },
    });
    expect(
      getByText(
        "Replacing Visa •••• 4242. The new card takes over immediately.",
      ),
    ).not.toBeNull();
  });

  test("a card with no last4 and no expiry reads its own sentence", () => {
    const { getByText } = renderShell({
      mode: "replace",
      cardOnFile: { brand: "visa", last4: null, expMonth: null, expYear: null },
    });
    expect(
      getByText(
        "Replacing your Visa card. The new card takes over immediately.",
      ),
    ).not.toBeNull();
  });

  test("a card with no brand and no expiry reads its own sentence", () => {
    const { getByText } = renderShell({
      mode: "replace",
      cardOnFile: { brand: null, last4: "4242", expMonth: null, expYear: null },
    });
    expect(
      getByText(
        "Replacing the card ending in 4242. The new card takes over immediately.",
      ),
    ).not.toBeNull();
  });

  test("a null card on file falls back to the plain subtitle", () => {
    const { getByText } = renderShell({ mode: "replace", cardOnFile: null });
    expect(getByText("The new card takes over immediately.")).not.toBeNull();
  });

  test("add mode ignores a card on file in the subtitle", () => {
    const { queryByText } = renderShell({ cardOnFile: VISA_ON_FILE });
    expect(queryByText(/Replacing/)).toBeNull();
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
    const { getByTestId, queryByTestId, queryByText } = renderShell({
      state: "saved",
      savedCard: { brand: "visa", last4: "1881" },
      autoReloadActive: true,
    });
    const panel = getByTestId("payment-method-modal-saved");
    expect(panel.textContent).toContain("Visa •••• 1881 saved");
    expect(panel.textContent).toContain("Auto-reload is active again");
    expect(queryByText("Cancel")).toBeNull();
    expect(queryByTestId("auto-top-up-pm-save-button")).toBeNull();
  });

  test("saved replaces the fields but keeps the mode-derived header", () => {
    const { getByRole, getByText, queryByTestId } = renderShell({
      state: "saved",
      savedCard: { brand: "visa", last4: "1881" },
    });
    expect(queryByTestId("field-block")).toBeNull();
    expect(queryByTestId("payment-method-modal-fields")).toBeNull();
    expect(getByText("Add a card")).not.toBeNull();

    const describedBy = getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Kept on file for auto-reload and your Pro plan.",
    );
    expect(queryByTestId("payment-method-modal-close")).not.toBeNull();
  });

  test("a headerless saved state leaves only a screen-reader title", () => {
    const { baseElement, getByRole, queryByText } = renderShell({
      state: "saved",
      headerless: true,
      savedCard: { brand: "visa", last4: "1881" },
    });
    expect(queryByText("Add a card")).toBeNull();
    expect(
      queryByText("Kept on file for auto-reload and your Pro plan."),
    ).toBeNull();

    const title = baseElement.querySelector('[data-slot="modal-title"]');
    expect(title?.className).toContain("sr-only");
    expect(title?.textContent).toBe("Visa •••• 1881 saved");
    expect(
      baseElement.querySelector('[data-slot="modal-description"]'),
    ).toBeNull();
    expect(getByRole("dialog").hasAttribute("aria-describedby")).toBe(false);
  });

  test("saved after a replace drops the card it just replaced", () => {
    const { getByText, getByTestId } = renderShell({
      mode: "replace",
      cardOnFile: VISA_ON_FILE,
      state: "saved",
      savedCard: { brand: "visa", last4: "1881" },
    });
    expect(getByText("The new card takes over immediately.")).not.toBeNull();
    expect(getByTestId("payment-method-modal-saved").textContent).toContain(
      "Visa •••• 1881 saved",
    );
  });

  test("saved drops the actionless footer and gutters the body instead", () => {
    const { baseElement } = renderShell({
      state: "saved",
      savedCard: { brand: "visa", last4: "1881" },
    });
    expect(baseElement.querySelector('[data-slot="modal-footer"]')).toBeNull();
    expect(
      baseElement.querySelector('[data-slot="modal-body"]')?.className,
    ).toContain("pb-[22px]");
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

  test("saved keeps the digits for a brand Stripe could not name", () => {
    const { getByTestId } = renderShell({
      state: "saved",
      savedCard: { brand: "unknown", last4: "1881" },
    });
    const panel = getByTestId("payment-method-modal-saved");
    expect(panel.textContent).toContain("Card ending in 1881 saved");
    expect(panel.textContent).not.toContain("unknown");
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
