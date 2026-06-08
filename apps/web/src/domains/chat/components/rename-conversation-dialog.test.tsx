/**
 * Tests for `RenameConversationDialog`.
 *
 * The component is a thin composition over `@vellumai/design-library`'s
 * `Modal` primitive (Radix Dialog under the hood). We mount it via
 * `@testing-library/react` (backed by happy-dom — see
 * `apps/web/test-setup.ts`) and exercise the user-facing behaviors that
 * matter: typing into the field, submitting via the Save button,
 * cancelling via Cancel, and the disabled-state heuristics that prevent
 * empty / no-op renames.
 *
 * Behaviors delegated to Radix (focus trap, Escape, portal mount) aren't
 * re-asserted here — they're tested upstream by the design library.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { RenameConversationDialog } from "@/domains/chat/components/rename-conversation-dialog.js";

afterEach(() => {
  cleanup();
});

function getNameInput(): HTMLInputElement {
  // The Modal portals into document.body, so query against the document
  // rather than the render container.
  const input = document.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("expected rename input to be in the DOM");
  return input;
}

function getButton(label: "Cancel" | "Save"): HTMLButtonElement {
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

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe("Initial render", () => {
  test("renders title, input pre-filled with currentTitle, and Cancel + Save buttons", () => {
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    // Modal.Title text appears in the portaled content.
    expect(document.body.textContent).toContain("Rename conversation");

    expect(getNameInput().value).toBe("Trip planning");
    expect(getButton("Cancel")).toBeTruthy();
    expect(getButton("Save")).toBeTruthy();
  });

  test("Save is disabled when the input matches currentTitle (no-op rename)", () => {
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getButton("Save").disabled).toBe(true);
  });

  test("Save is disabled when currentTitle is empty and the user hasn't typed yet", () => {
    render(
      <RenameConversationDialog
        open
        currentTitle=""
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getButton("Save").disabled).toBe(true);
  });

  test("does not render anything portaled when open=false", () => {
    render(
      <RenameConversationDialog
        open={false}
        currentTitle="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("Rename conversation");
  });
});

// ---------------------------------------------------------------------------
// Edit + submit flow
// ---------------------------------------------------------------------------

describe("Edit + submit", () => {
  test("typing a new value enables Save", () => {
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "Paris trip" } });
    expect(getButton("Save").disabled).toBe(false);
  });

  test("clicking Save invokes onSubmit with the trimmed new title", () => {
    const onSubmit = mock(() => {});
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), {
      target: { value: "  Paris trip  " },
    });
    fireEvent.click(getButton("Save"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Paris trip");
  });

  test("pressing Enter in the input submits the form", () => {
    const onSubmit = mock(() => {});
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "Paris trip" } });

    // Submitting the surrounding <form> matches the real-world Enter-key
    // path. happy-dom doesn't synthesize a form submit purely from a
    // keydown, so we trigger the form directly.
    const form = getNameInput().closest("form");
    if (!form) throw new Error("expected the input to be inside a <form>");
    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Paris trip");
  });

  test("Save stays disabled (and onSubmit doesn't fire) when input is whitespace only", () => {
    const onSubmit = mock(() => {});
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "   " } });
    expect(getButton("Save").disabled).toBe(true);
    fireEvent.click(getButton("Save"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("Save stays disabled when typed value trims back to currentTitle", () => {
    const onSubmit = mock(() => {});
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), {
      target: { value: "  Trip planning  " },
    });
    expect(getButton("Save").disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancel flow
// ---------------------------------------------------------------------------

describe("Cancel", () => {
  test("clicking Cancel invokes onCancel", () => {
    const onCancel = mock(() => {});
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(getButton("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("clicking Cancel after typing does not invoke onSubmit", () => {
    const onSubmit = mock(() => {});
    const onCancel = mock(() => {});
    render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "Paris" } });
    fireEvent.click(getButton("Cancel"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Reset on reopen
// ---------------------------------------------------------------------------

describe("Reset on reopen", () => {
  test("rerendering with a new currentTitle while open repopulates the input", () => {
    const { rerender } = render(
      <RenameConversationDialog
        open
        currentTitle="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "Paris" } });
    expect(getNameInput().value).toBe("Paris");

    // Simulates re-opening the dialog against a different conversation:
    // the consumer keeps `open=true` but swaps the title.
    rerender(
      <RenameConversationDialog
        open
        currentTitle="Grocery list"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getNameInput().value).toBe("Grocery list");
  });
});
