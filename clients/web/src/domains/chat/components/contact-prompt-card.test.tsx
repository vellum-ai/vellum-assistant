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

describe("ContactPromptCard prefill", () => {
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

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("user@example.com");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("leaves the input empty and Save disabled when no placeholder is provided", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{ requestId: "req-2", channel: "email" }}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("submits the edited address, not the original placeholder", () => {
    const onSubmit = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-3",
          channel: "email",
          placeholder: "user@example.com",
        }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("edited@example.com", "email");
  });

  test("clicking Save with a pre-filled placeholder submits that address", () => {
    const onSubmit = mock(() => {});

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-4",
          channel: "sms",
          placeholder: "555-0100",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith("555-0100", "sms");
  });
});
