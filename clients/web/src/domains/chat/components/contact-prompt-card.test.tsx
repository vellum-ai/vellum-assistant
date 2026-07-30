import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ContactPromptCard } from "@/domains/chat/components/contact-prompt-card";

// No jest-dom matchers registered in test-setup.ts — assert against raw DOM
// properties instead of toHaveValue()/toBeDisabled().

function noop() {}

const baseProps = {
  isSubmitting: false,
  accepted: false,
  onSubmit: noop,
  onCancel: noop,
};

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

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("user@example.com");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("leaves the input empty and Save disabled when no defaultValue is provided", () => {
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

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("submits the edited address, not the original defaultValue", () => {
    const onSubmit = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-3",
          channel: "email",
          defaultValue: "user@example.com",
          placeholder: "Enter email address",
        }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("edited@example.com", "email");
  });

  test("clicking Save with a pre-filled defaultValue submits that address", () => {
    const onSubmit = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-4",
          channel: "sms",
          defaultValue: "555-0100",
          placeholder: "Enter phone number",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith("555-0100", "sms");
  });

  test("resets the address when requestId changes", () => {
    const { rerender } = render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-5",
          channel: "email",
          defaultValue: "first@example.com",
        }}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("first@example.com");

    // Simulate a new contact_request replacing the old one while mounted
    rerender(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-6",
          channel: "email",
          defaultValue: "second@example.com",
        }}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("second@example.com");
  });

  test("resets to empty when a new request has no defaultValue", () => {
    const { rerender } = render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-7",
          channel: "email",
          defaultValue: "first@example.com",
        }}
      />,
    );

    rerender(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-8",
          channel: "email",
        }}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
