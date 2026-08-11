/**
 * Tests for `ConnectRecoveryDialog`.
 *
 * The component composes `@vellumai/design-library`'s `Modal` and
 * `ConfirmDialog` (Radix Dialog under the hood), mounted via
 * `@testing-library/react` on happy-dom — same approach as
 * `name-input-dialog.test.tsx`. The real library components are
 * rendered so the destructive styling and `isPending` behavior asserted
 * here are the actual shipped behavior, not a mock's.
 *
 * What matters: repair is a single click (the reconnect path a user walks on
 * every launch), while retire stays behind its destructive confirmation and
 * out of the primary button stack.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ConnectRecoveryDialog } from "@/domains/onboarding/components/connect-recovery-dialog";

afterEach(cleanup);

function findButton(label: string): HTMLButtonElement | undefined {
  // Modals portal into document.body, so query the document rather than
  // the render container.
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
}

function getButton(label: string): HTMLButtonElement {
  const match = findButton(label);
  if (!match) {
    throw new Error(
      `expected to find a "${label}" button — saw: ${Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      )
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

const RETIRE_ACTION = "Retire Assistant…";

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
    expect(document.body.textContent).toContain("Can’t Authenticate Assistant");
    expect(document.body.textContent).toContain(
      "The authentication token for Local Assistant",
    );
    expect(getButton("Wake & Repair")).toBeTruthy();
    expect(getButton(RETIRE_ACTION)).toBeTruthy();
    expect(getButton("Cancel")).toBeTruthy();
  });

  test("states the repair side effect up front, since repair is one click", () => {
    renderDialog();
    expect(document.body.textContent).toContain(
      "signed out and need to reconnect",
    );
  });

  test("retire sits apart from the primary stack, compact and low-emphasis", () => {
    renderDialog();
    const repair = getButton("Wake & Repair");
    const retire = getButton(RETIRE_ACTION);
    // Not a sibling of the primary button: a stray click below "Wake & Repair"
    // lands on Cancel, never on the destructive action.
    expect(retire.parentElement).not.toBe(repair.parentElement);
    expect(repair.parentElement?.contains(retire)).toBe(false);
    expect(retire.className).toContain("h-6");
    expect(retire.className).not.toContain("w-full");
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

describe("Repair", () => {
  test("Wake & Repair fires onRepair on a single click", () => {
    const { onRepair, onRetire, onCancel } = renderDialog();
    fireEvent.click(getButton("Wake & Repair"));
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(onRetire).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // No confirmation step stands between the click and the repair.
    expect(document.body.textContent).not.toContain("Repair Assistant?");
  });

  test("isPending shows progress and blocks a second repair", () => {
    const { rerender, onRepair, onCancel } = renderDialog();
    rerender({ isPending: true });
    expect(findButton("Wake & Repair")).toBeUndefined();
    const repairing = getButton("Repairing…");
    expect(repairing.disabled).toBe(true);
    fireEvent.click(repairing);
    expect(onRepair).not.toHaveBeenCalled();
    // The escape hatches are held too, so a click can't race the repair.
    expect(getButton("Cancel").disabled).toBe(true);
    expect(getButton(RETIRE_ACTION).disabled).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("Retire confirmation", () => {
  test("retire advances to a destructive confirmation instead of firing onRetire", () => {
    const { onRetire } = renderDialog();
    fireEvent.click(getButton(RETIRE_ACTION));
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
    fireEvent.click(getButton(RETIRE_ACTION));
    fireEvent.click(getButton("Cancel"));
    expect(getButton("Wake & Repair")).toBeTruthy();
    expect(onRetire).not.toHaveBeenCalled();

    fireEvent.click(getButton(RETIRE_ACTION));
    fireEvent.click(getButton("Retire"));
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  test("isPending disables the confirm button", () => {
    const { rerender, onRetire } = renderDialog();
    fireEvent.click(getButton(RETIRE_ACTION));
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

  test("errorMessage renders inside the retire confirmation", () => {
    const { rerender } = renderDialog();
    fireEvent.click(getButton(RETIRE_ACTION));
    rerender({ errorMessage: "Failed to retire assistant. Please try again." });
    expect(document.body.textContent).toContain("Retire Assistant");
    expect(document.body.textContent).toContain(
      "Failed to retire assistant. Please try again.",
    );
  });
});

describe("Reset on reopen", () => {
  test("reopening lands on the menu even if closed mid-confirmation", () => {
    const { rerender } = renderDialog();
    fireEvent.click(getButton(RETIRE_ACTION));
    expect(document.body.textContent).toContain(
      "This will permanently retire this assistant",
    );

    rerender({ open: false });
    rerender({ open: true });
    expect(document.body.textContent).toContain("Can’t Authenticate Assistant");
    expect(getButton("Wake & Repair")).toBeTruthy();
  });
});
