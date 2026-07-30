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

  test("pre-fills the input with defaultValue and enables Save", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-1",
          channel: "email",
          defaultValue: "user@example.com",
          placeholder: "Enter email address",
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
        contactRequest={{
          requestId: "req-2",
          channel: "email",
          placeholder: "Enter email address",
        }}
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

  test("submits the edited address, not the original defaultValue", () => {
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
