/**
 * Undo takes the Done toast with it.
 *
 * The sidebar's Done toast is the only place a checked row can be brought
 * back, so a toast that stayed up after Undo would offer to undo something
 * already undone. The dismissal belongs to the design library's toast body,
 * which runs the action and then closes; this pins that contract from the
 * side that depends on it, because losing it would be silent here.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ToastContent } from "@vellumai/design-library/components/toast";

afterEach(cleanup);

describe("the Done toast's Undo", () => {
  test("runs the action and closes the toast, in that order", () => {
    const calls: string[] = [];
    const { getByText } = render(
      createElement(ToastContent, {
        message: "Done",
        options: {
          description: "Launch review brief",
          action: { label: "Undo", onClick: () => calls.push("undo") },
        },
        onDismiss: () => calls.push("dismiss"),
      }),
    );

    fireEvent.click(getByText("Undo"));
    expect(calls).toEqual(["undo", "dismiss"]);
  });

  test("the close control dismisses without running the action", () => {
    const action = mock(() => {});
    const onDismiss = mock(() => {});
    const { getByLabelText } = render(
      createElement(ToastContent, {
        message: "Done",
        options: { action: { label: "Undo", onClick: action } },
        onDismiss,
      }),
    );

    fireEvent.click(getByLabelText("Close"));
    expect(action).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
