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

  test("a rename says nothing about the notes it did not touch", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "update",
          contactId: "c-1",
          currentDisplayName: "Alice",
          currentNotes: "  spaced notes  ",
        }}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "Alice Chen" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Omitted rather than echoed, so notes edited elsewhere while this form
    // was open survive, and untouched whitespace is not normalised either.
    expect(onSubmit).toHaveBeenCalledWith({
      displayName: "Alice Chen",
      notes: undefined,
    });
  });

  test("an edit to the notes says nothing about the name", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "update",
          contactId: "c-1",
          currentDisplayName: "Alice",
          currentNotes: "Dentist",
        }}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[1], { target: { value: "Moved to Berlin" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      displayName: undefined,
      notes: "Moved to Berlin",
    });
  });

  test("a create says everything, since there is nothing to preserve", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "create",
          displayName: "Alice",
          notes: "Dentist",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      displayName: "Alice",
      notes: "Dentist",
    });
  });

  test("accepting a proposed name writes it", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "update",
          contactId: "c-1",
          currentDisplayName: "Alice",
          displayName: "Alice Chen",
        }}
      />,
    );

    // The guardian read the proposal and pressed Save without editing. That is
    // an acceptance, not an absence of change.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      displayName: "Alice Chen",
      notes: undefined,
    });
  });

  test("accepting proposed notes writes them", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "update",
          contactId: "c-1",
          currentDisplayName: "Alice",
          currentNotes: "Dentist",
          notes: "Dentist, moved to Berlin",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      displayName: undefined,
      notes: "Dentist, moved to Berlin",
    });
  });

  test("a form submitted with nothing changed writes nothing", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "update",
          contactId: "c-1",
          currentDisplayName: "Alice",
          currentNotes: "Dentist",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      displayName: undefined,
      notes: undefined,
    });
  });

  test("an explicitly proposed note is submitted even when it matches", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "update",
          contactId: "c-1",
          currentDisplayName: "Alice",
          currentNotes: "",
          notes: "",
          notesProposed: true,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // `--notes ""` is a request to clear them. Comparison alone cannot tell
    // that from notes the read could not see, which also arrive as empty.
    expect(onSubmit).toHaveBeenCalledWith({
      displayName: undefined,
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

  test("delete names the channels, so two same-named contacts are tellable apart", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "delete",
          contactId: "c-1",
          currentDisplayName: "Alice",
          channels: [
            { type: "email", address: "alice@example.com" },
            { type: "phone", address: "+15555550142" },
          ],
        }}
      />,
    );

    expect(screen.getByText(/alice@example.com/)).toBeDefined();
    expect(screen.getByText(/\+15555550142/)).toBeDefined();
  });

  test("delete says so when there are no channels to lose", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "delete",
          contactId: "c-1",
          currentDisplayName: "Alice",
          channels: [],
        }}
      />,
    );

    expect(screen.getByText(/no channels/i)).toBeDefined();
  });

  test("merge names both contacts and the channels moving over", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "merge",
          contactId: "c-1",
          currentDisplayName: "Alice Chen",
          donorContactId: "c-2",
          donorDisplayName: "Alice C",
          donorChannels: [
            { type: "email", address: "alice@example.com" },
            { type: "phone", address: "+15555550142" },
          ],
        }}
      />,
    );

    expect(screen.getByText("Merge Alice C into Alice Chen?")).toBeDefined();
    expect(screen.getByText(/alice@example.com/)).toBeDefined();
    expect(screen.getByText(/\+15555550142/)).toBeDefined();
  });

  test("merge shows the survivor's channels too, so same-named records are distinguishable", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "merge",
          contactId: "c-1",
          currentDisplayName: "Alice Chen",
          channels: [{ type: "email", address: "survivor@example.com" }],
          donorContactId: "c-2",
          donorDisplayName: "Alice Chen",
          donorChannels: [{ type: "phone", address: "+15555550142" }],
        }}
      />,
    );

    // Two contacts can share a name, so the addresses on each side are what
    // say which record survives.
    expect(screen.getByText(/survivor@example.com/)).toBeDefined();
    expect(screen.getByText(/\+15555550142/)).toBeDefined();
  });

  test("merge says so when the donor has no channels to move", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "merge",
          contactId: "c-1",
          currentDisplayName: "Alice Chen",
          donorContactId: "c-2",
          donorDisplayName: "Alice C",
          donorChannels: [],
          channels: [{ type: "email", address: "survivor@example.com" }],
        }}
      />,
    );

    expect(screen.getByText(/no channels/i)).toBeDefined();
    expect(screen.getByText(/survivor@example.com/)).toBeDefined();
  });

  test("merge offers the surviving name and no notes field", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "merge",
          contactId: "c-1",
          currentDisplayName: "Alice Chen",
          donorContactId: "c-2",
          donorDisplayName: "Alice C",
        }}
      />,
    );

    // The store combines the two contacts' notes, so the form does not offer
    // them: the name is the only thing the guardian decides.
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].value).toBe("Alice Chen");
  });

  test("merge submits the name the guardian picked for the survivor", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "merge",
          contactId: "c-1",
          currentDisplayName: "Alice Chen",
          donorContactId: "c-2",
          donorDisplayName: "Alice C",
        }}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "Alice C. Chen" } });
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(onSubmit).toHaveBeenCalledWith({ displayName: "Alice C. Chen" });
  });

  test("a merge that keeps the surviving name says nothing about it", () => {
    const onSubmit = mock(noop);
    render(
      <ContactRecordCard
        {...baseProps}
        onSubmit={onSubmit}
        request={{
          requestId: "req-1",
          operation: "merge",
          contactId: "c-1",
          currentDisplayName: "Alice Chen",
          donorContactId: "c-2",
          donorDisplayName: "Alice C",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(onSubmit).toHaveBeenCalledWith({ displayName: undefined });
  });

  test("a merge cannot be submitted with a blank surviving name", () => {
    render(
      <ContactRecordCard
        {...baseProps}
        request={{
          requestId: "req-1",
          operation: "merge",
          contactId: "c-1",
          currentDisplayName: "Alice Chen",
          donorContactId: "c-2",
          donorDisplayName: "Alice C",
        }}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "   " } });

    const merge = screen.getByRole("button", {
      name: "Merge",
    }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
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
