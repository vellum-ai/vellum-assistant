import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ContactRecordCard } from "@/domains/chat/components/contact-record-card";

// No jest-dom matchers registered in test-setup.ts, so assert against raw DOM
// properties instead of toHaveValue()/toBeDisabled().

function noop() {}

const baseProps = {
  isSubmitting: false,
  accepted: false,
  onSubmit: noop,
  onCancel: noop,
};

describe("ContactRecordCard", () => {
  afterEach(() => {
    cleanup();
  });

  test("seeds the form with the proposed name and notes", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "create",
          displayName: "Alice",
          notes: "Dentist",
        }}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs[0].value).toBe("Alice");
    expect(inputs[1].value).toBe("Dentist");
  });

  test("submits the guardian's edit, not the proposal", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "create",
          displayName: "Alice",
        }}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "Alice Chen" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      displayName: "Alice Chen",
      notes: "",
    });
  });

  test("an empty name cannot be submitted", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{ requestId: "req-1", operation: "create" }}
      />,
    );

    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  test("update seeds from the current name when nothing else is proposed", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "update",
          contactId: "c-1",
          currentDisplayName: "Alice",
        }}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs[0].value).toBe("Alice");
  });

  test("delete asks for confirmation only, with no editable fields", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "delete",
          contactId: "c-1",
          currentDisplayName: "Alice",
        }}
      />,
    );

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    // The warning is the point of the card: deleting takes their channels too.
    expect(screen.getByText(/no longer reach your assistant/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("dismissing does not submit", () => {
    const onSubmit = mock(noop);
    const onCancel = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        onCancel={onCancel}
        request={{
          requestId: "req-1",
          operation: "create",
          displayName: "Alice",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
