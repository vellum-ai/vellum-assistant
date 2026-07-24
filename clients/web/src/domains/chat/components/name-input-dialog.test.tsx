/**
 * Tests for `NameInputDialog` — the shared name entry/edit dialog used for
 * conversation rename and group create/rename.
 *
 * The component is a thin composition over `@vellumai/design-library`'s
 * `Modal` primitive (Radix Dialog under the hood). We mount it via
 * `@testing-library/react` (backed by happy-dom — see
 * `clients/web/test-setup.ts`) and exercise the user-facing behaviors that
 * matter: typing into the field, submitting, cancelling, and the
 * disabled-state heuristics that prevent empty / no-op edits.
 *
 * Behaviors delegated to Radix (focus trap, Escape, portal mount) aren't
 * re-asserted here — they're tested upstream by the design library.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { NameInputDialog } from "@/domains/chat/components/name-input-dialog";

afterEach(() => {
  cleanup();
});

function getNameInput(): HTMLInputElement {
  // The Modal portals into document.body, so query against the document
  // rather than the render container.
  const input = document.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("expected name input to be in the DOM");
  return input;
}

function getButton(label: string): HTMLButtonElement {
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
// Rename variant (title/label passed in by the caller)
// ---------------------------------------------------------------------------

describe("Initial render", () => {
  test("renders the passed title, input pre-filled with initialValue, and Cancel + submit buttons", () => {
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(document.body.textContent).toContain("Rename conversation");
    expect(getNameInput().value).toBe("Trip planning");
    expect(getButton("Cancel")).toBeTruthy();
    expect(getButton("Save")).toBeTruthy();
  });

  test("submit is disabled when the input matches initialValue (no-op edit)", () => {
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getButton("Save").disabled).toBe(true);
  });

  test("submit is disabled when initialValue is empty and the user hasn't typed yet", () => {
    render(
      <NameInputDialog
        open
        title="New group"
        submitLabel="Create"
        initialValue=""
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getButton("Create").disabled).toBe(true);
  });

  test("does not render anything portaled when open=false", () => {
    render(
      <NameInputDialog
        open={false}
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("Rename conversation");
  });
});

describe("Edit + submit", () => {
  test("typing a new value enables submit", () => {
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "Paris trip" } });
    expect(getButton("Save").disabled).toBe(false);
  });

  test("clicking submit invokes onSubmit with the trimmed value", () => {
    const onSubmit = mock(() => {});
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "  Paris trip  " } });
    fireEvent.click(getButton("Save"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Paris trip");
  });

  test("pressing Enter in the input submits the form", () => {
    const onSubmit = mock(() => {});
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "Paris trip" } });

    const form = getNameInput().closest("form");
    if (!form) throw new Error("expected the input to be inside a <form>");
    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Paris trip");
  });

  test("submit stays disabled (and onSubmit doesn't fire) when input is whitespace only", () => {
    const onSubmit = mock(() => {});
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "   " } });
    expect(getButton("Save").disabled).toBe(true);
    fireEvent.click(getButton("Save"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("submit stays disabled when the typed value trims back to initialValue", () => {
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "  Trip planning  " } });
    expect(getButton("Save").disabled).toBe(true);
  });
});

describe("Create variant", () => {
  test("uses the passed create title + submit label and enables on typing", () => {
    const onSubmit = mock(() => {});
    render(
      <NameInputDialog
        open
        title="New group"
        submitLabel="Create"
        initialValue=""
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    expect(document.body.textContent).toContain("New group");
    expect(getButton("Create").disabled).toBe(true);

    fireEvent.change(getNameInput(), { target: { value: "Research" } });
    expect(getButton("Create").disabled).toBe(false);
    fireEvent.click(getButton("Create"));
    expect(onSubmit).toHaveBeenCalledWith("Research");
  });
});

describe("Cancel", () => {
  test("clicking Cancel invokes onCancel and not onSubmit", () => {
    const onSubmit = mock(() => {});
    const onCancel = mock(() => {});
    render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
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

describe("Reset on reopen", () => {
  test("rerendering with a new initialValue while open repopulates the input", () => {
    const { rerender } = render(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Trip planning"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(getNameInput(), { target: { value: "Paris" } });
    expect(getNameInput().value).toBe("Paris");

    rerender(
      <NameInputDialog
        open
        title="Rename conversation"
        submitLabel="Save"
        initialValue="Grocery list"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getNameInput().value).toBe("Grocery list");
  });
});
