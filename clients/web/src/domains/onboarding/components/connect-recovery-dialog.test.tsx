/**
 * Tests for `ConnectRecoveryDialog`.
 *
 * The component composes `@vellumai/design-library`'s `Modal` and
 * `ConfirmDialog` (Radix Dialog under the hood), mounted via
 * `@testing-library/react` on happy-dom — same approach as
 * `rename-conversation-dialog.test.tsx`. The real library components are
 * rendered so the destructive styling and `isPending` behavior asserted
 * here are the actual shipped behavior, not a mock's.
 *
 * What matters: the step machine. `onRepair`/`onRetire` must only ever
 * fire from their nested confirmation steps, never from the menu.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ConnectRecoveryDialog } from "@/domains/onboarding/components/connect-recovery-dialog";

afterEach(cleanup);

function getButton(label: string): HTMLButtonElement {
  // Modals portal into document.body, so query the document rather than
  // the render container.
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  );
  const match = buttons.find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(
      `expected to find a "${label}" button — saw: ${buttons
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

function renderDialog(
  overrides: Partial<Parameters<typeof ConnectRecoveryDialog>[0]> = {},
) {
  const onCancel = mock(() => {});
  const onRepair = mock(() => {});
  const onRetire = mock(() => {});
  const props = {
    open: true,
    assistantName: "Local Assistant",
    isPending: false,
    onCancel,
    onRepair,
    onRetire,
    ...overrides,
  };
  const { rerender } = render(<ConnectRecoveryDialog {...props} />);
  return {
    onCancel,
    onRepair,
    onRetire,
    rerender: (next: Partial<Parameters<typeof ConnectRecoveryDialog>[0]>) =>
      rerender(<ConnectRecoveryDialog {...props} {...next} />),
  };
}

describe("Menu step", () => {
  test("renders the title, assistant name, and all three actions", () => {
    renderDialog();
    expect(document.body.textContent).toContain(
      "Can’t Authenticate Assistant",
    );
    expect(document.body.textContent).toContain(
      "The authentication token for Local Assistant",
    );
    expect(getButton("Wake & Repair")).toBeTruthy();
    expect(getButton("Retire Assistant")).toBeTruthy();
    expect(getButton("Cancel")).toBeTruthy();
  });

  test("renders nothing when open=false", () => {
    renderDialog({ open: false });
    expect(document.querySelector("button")).toBeNull();
  });

  test("Cancel fires onCancel without firing onRepair or onRetire", () => {
    const { onCancel, onRepair, onRetire } = renderDialog();
    fireEvent.click(getButton("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRepair).not.toHaveBeenCalled();
    expect(onRetire).not.toHaveBeenCalled();
  });
});

describe("Repair confirmation", () => {
  test("Wake & Repair advances to the confirmation instead of firing onRepair", () => {
    const { onRepair } = renderDialog();
    fireEvent.click(getButton("Wake & Repair"));
    expect(onRepair).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Repair Assistant?");
    // The confirmation states the real side effect.
    expect(document.body.textContent).toContain(
      "signed out and need to reconnect",
    );
  });

  test("confirming fires onRepair", () => {
    const { onRepair } = renderDialog();
    fireEvent.click(getButton("Wake & Repair"));
    fireEvent.click(getButton("Repair"));
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  test("canceling the confirmation returns to the menu without firing callbacks", () => {
    const { onRepair, onCancel } = renderDialog();
    fireEvent.click(getButton("Wake & Repair"));
    fireEvent.click(getButton("Cancel"));
    expect(document.body.textContent).toContain(
      "Can’t Authenticate Assistant",
    );
    expect(onRepair).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("isPending disables the confirm button", () => {
    const { rerender, onRepair } = renderDialog();
    fireEvent.click(getButton("Wake & Repair"));
    rerender({ isPending: true });
    const repair = getButton("Repair");
    expect(repair.disabled).toBe(true);
    fireEvent.click(repair);
    expect(onRepair).not.toHaveBeenCalled();
  });
});

describe("Retire confirmation", () => {
  test("Retire Assistant advances to a destructive confirmation instead of firing onRetire", () => {
    const { onRetire } = renderDialog();
    fireEvent.click(getButton("Retire Assistant"));
    expect(onRetire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "This will permanently retire this assistant and all of its data.",
    );
    // ConfirmDialog's destructive variant styles the confirm as a danger
    // button.
    expect(getButton("Retire").className).toContain(
      "bg-[var(--system-negative-strong)]",
    );
  });

  test("confirming fires onRetire; canceling returns to the menu", () => {
    const { onRetire } = renderDialog();
    fireEvent.click(getButton("Retire Assistant"));
    fireEvent.click(getButton("Cancel"));
    expect(getButton("Wake & Repair")).toBeTruthy();
    expect(onRetire).not.toHaveBeenCalled();

    fireEvent.click(getButton("Retire Assistant"));
    fireEvent.click(getButton("Retire"));
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  test("isPending disables the confirm button", () => {
    const { rerender, onRetire } = renderDialog();
    fireEvent.click(getButton("Retire Assistant"));
    rerender({ isPending: true });
    const retire = getButton("Retire");
    expect(retire.disabled).toBe(true);
    fireEvent.click(retire);
    expect(onRetire).not.toHaveBeenCalled();
  });
});

describe("Error display", () => {
  test("errorMessage renders in the menu step", () => {
    renderDialog({ errorMessage: "Repair failed. Please try again." });
    expect(document.body.textContent).toContain(
      "Repair failed. Please try again.",
    );
  });

  test("errorMessage renders inside the active confirmation step", () => {
    const { rerender } = renderDialog();
    fireEvent.click(getButton("Wake & Repair"));
    rerender({ errorMessage: "Repair failed. Please try again." });
    // Still on the confirmation step, with the failure shown inline.
    expect(document.body.textContent).toContain("Repair Assistant?");
    expect(document.body.textContent).toContain(
      "Repair failed. Please try again.",
    );
  });
});

describe("Reset on reopen", () => {
  test("reopening lands on the menu even if closed mid-confirmation", () => {
    const { rerender } = renderDialog();
    fireEvent.click(getButton("Wake & Repair"));
    expect(document.body.textContent).toContain("Repair Assistant?");

    rerender({ open: false });
    rerender({ open: true });
    expect(document.body.textContent).toContain(
      "Can’t Authenticate Assistant",
    );
    expect(getButton("Wake & Repair")).toBeTruthy();
  });
});
