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

    expect(onSubmit).toHaveBeenCalledWith("555-0100", "sms", false, undefined);
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
    expect(onSubmit).toHaveBeenCalledWith(
      "edited@example.com",
      "email",
      false,
      undefined,
    );
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

describe("ContactPromptCard verify checkbox", () => {
  afterEach(() => {
    cleanup();
  });

  function verifyBox(): HTMLElement {
    return screen.getByRole("checkbox");
  }

  test("is unchecked when the command did not ask for it", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{ requestId: "req-1", channel: "email" }}
      />,
    );

    expect(verifyBox().getAttribute("data-state")).toBe("unchecked");
  });

  test("is pre-checked by --verify, and submits that answer", () => {
    const onSubmit = mock(noop);
    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-1",
          channel: "email",
          defaultValue: "user@example.com",
          verify: true,
        }}
      />,
    );

    expect(verifyBox().getAttribute("data-state")).toBe("checked");
    fireEvent.click(saveButton());
    expect(onSubmit).toHaveBeenCalledWith(
      "user@example.com",
      "email",
      true,
      undefined,
    );
  });

  test("unchecking a pre-checked box submits false, so --verify cannot attest behind the guardian", () => {
    const onSubmit = mock(noop);
    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-1",
          channel: "email",
          defaultValue: "user@example.com",
          verify: true,
        }}
      />,
    );

    fireEvent.click(verifyBox());
    fireEvent.click(saveButton());

    expect(onSubmit).toHaveBeenCalledWith(
      "user@example.com",
      "email",
      false,
      undefined,
    );
  });
});

describe("ContactPromptCard target contact", () => {
  afterEach(() => {
    cleanup();
  });

  test("names the contact the channel is being added to", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-1",
          channel: "email",
          contactId: "contact-1",
          contactDisplayName: "Alice Chen",
        }}
      />,
    );

    expect(screen.getByText("Adding a channel to Alice Chen")).toBeTruthy();
  });

  test("names no contact when the form targets none", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{ requestId: "req-2", channel: "email" }}
      />,
    );

    expect(screen.queryByText(/Adding a channel to/)).toBeNull();
  });
});

describe("ContactPromptCard proposed name", () => {
  afterEach(() => {
    cleanup();
  });

  function nameInput(): HTMLInputElement {
    return screen.getByPlaceholderText("Name") as HTMLInputElement;
  }

  test("seeds an editable name field and submits what the guardian left", () => {
    const onSubmit = mock(noop);

    render(
      <ContactPromptCard
        {...baseProps}
        onSubmit={onSubmit}
        contactRequest={{
          requestId: "req-1",
          channel: "email",
          displayName: "Alice",
          placeholder: "Enter email address",
        }}
      />,
    );

    expect(nameInput().value).toBe("Alice");

    fireEvent.change(nameInput(), { target: { value: "Alice Chen" } });
    fireEvent.change(screen.getByPlaceholderText("Enter email address"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(saveButton());

    expect(onSubmit).toHaveBeenCalledWith(
      "ada@example.com",
      "email",
      false,
      "Alice Chen",
    );
  });

  test("blanking a proposed name blocks Save, so no contact is created unnamed", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-2",
          channel: "email",
          displayName: "Alice",
          defaultValue: "ada@example.com",
        }}
      />,
    );

    expect(saveButton().disabled).toBe(false);
    fireEvent.change(nameInput(), { target: { value: "  " } });
    expect(saveButton().disabled).toBe(true);
  });

  test("renders no name field when the form proposes none", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-3",
          channel: "email",
          defaultValue: "ada@example.com",
        }}
      />,
    );

    expect(screen.queryByPlaceholderText("Name")).toBeNull();
  });

  test("shows proposed notes read only", () => {
    render(
      <ContactPromptCard
        {...baseProps}
        contactRequest={{
          requestId: "req-4",
          channel: "email",
          displayName: "Alice",
          notes: "Met at the design review",
        }}
      />,
    );

    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText("Met at the design review")).toBeTruthy();
    expect(
      screen.queryByDisplayValue("Met at the design review"),
    ).toBeNull();
  });
});
