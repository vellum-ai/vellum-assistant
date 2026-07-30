import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ContactPromptCard } from "@/domains/chat/components/contact-prompt-card";

// No jest-dom matchers registered in test-setup.ts, so assert against raw DOM
// properties instead of toHaveValue()/toBeDisabled().

function noop() {}

const baseProps = {
  isSubmitting: false,
  accepted: false,
  onSubmit: noop,
  onConfirmMerge: noop,
  onCancel: noop,
};

function addressInput(): HTMLInputElement {
  return screen.getByRole("textbox") as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

describe("ContactPromptCard defaultValue", () => {
  afterEach(() => {
    cleanup();
  });

  test("pre-fills the input with the suggested placeholder and enables Save", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-1",
          channel: "email",
          placeholder: "user@example.com",
        }}
      />,
    );

    expect(addressInput().value).toBe("user@example.com");
    expect(saveButton().disabled).toBe(false);
  });

  test("leaves the input empty and Save disabled when only a placeholder is provided", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{ requestId: "req-2", channel: "email" }}
      />,
    );

    expect(addressInput().value).toBe("");
    expect(addressInput().placeholder).toBe("Enter email address");
    expect(saveButton().disabled).toBe(true);
  });

  test("submits the pre-filled defaultValue as-is", () => {
    const onSubmit = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-3",
          channel: "sms",
          defaultValue: "555-0100",
        }}
      />,
    );

    fireEvent.click(saveButton());

    expect(onSubmit).toHaveBeenCalledWith("555-0100", "sms");
  });

  test("submits the edited address, not the original placeholder", () => {
    const onSubmit = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-4",
          channel: "email",
          defaultValue: "user@example.com",
        }}
      />,
    );

    fireEvent.change(addressInput(), {
      target: { value: "edited@example.com" },
    });
    fireEvent.click(saveButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("edited@example.com", "email");
  });

  test("keying by requestId resets the address when a new request arrives", () => {
    // Mirrors PendingContactRequestRow, which keys the card by requestId so a
    // replacement contact_request remounts it instead of keeping stale state.
    const { rerender } = render(
      <ContactPromptCard
        key="req-5"
        {...baseProps}
        contactRequest={{
          requestId: "req-5",
          channel: "email",
          defaultValue: "first@example.com",
        }}
      />,
    );

    fireEvent.change(addressInput(), {
      target: { value: "typed@example.com" },
    });

    rerender(
      <ContactPromptCard
        key="req-6"
        {...baseProps}
        contactRequest={{
          requestId: "req-6",
          channel: "email",
          defaultValue: "second@example.com",
        }}
      />,
    );

    expect(addressInput().value).toBe("second@example.com");
  });
});

describe("ContactPromptCard merge mode", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders a confirm/cancel UI instead of an address form", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-merge-1",
          mode: "merge",
          keepId: "keep-1",
          discardId: "discard-1",
          keepName: "Alice",
          discardName: "Alice (duplicate)",
        }}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Alice (duplicate)")).toBeTruthy();
  });

  test("clicking Merge calls onConfirmMerge, not onSubmit", () => {
    const onSubmit = mock(() => {});
    const onConfirmMerge = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        onConfirmMerge={onConfirmMerge}
        contactRequest={{
          requestId: "req-merge-2",
          mode: "merge",
          keepId: "keep-1",
          discardId: "discard-1",
          keepName: "Alice",
          discardName: "Alice (duplicate)",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(onConfirmMerge).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("clicking Cancel calls onCancel", () => {
    const onCancel = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onCancel={onCancel}
        contactRequest={{
          requestId: "req-merge-3",
          mode: "merge",
          keepId: "keep-1",
          discardId: "discard-1",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("shows the merged success state instead of the contact-saved message", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        accepted
        contactRequest={{
          requestId: "req-merge-4",
          mode: "merge",
          keepId: "keep-1",
          discardId: "discard-1",
        }}
      />,
    );

    expect(screen.getByText("Contacts merged")).toBeTruthy();
    expect(screen.queryByText("Contact saved")).toBeNull();
  });
});
