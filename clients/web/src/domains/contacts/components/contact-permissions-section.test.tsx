import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { ContactPayload } from "@/domains/contacts/types";

mock.module("@vellumai/design-library/components/select", () => ({
  Select: ({
    value,
    onChange,
    onSelectNone,
    options,
    disabled,
  }: {
    value: string | null;
    onChange: (value: string) => void;
    onSelectNone?: () => void;
    options: Array<{ value: string | null; label: string }>;
    disabled?: boolean;
  }) =>
    createElement(
      "select",
      {
        "data-testid": "contact-permissions-select",
        disabled,
        value: value ?? "",
        onChange: (event: { target: { value: string } }) => {
          const next = event.target.value;
          if (next === "") {
            onSelectNone?.();
            return;
          }
          onChange(next);
        },
      },
      options.map((option) =>
        createElement(
          "option",
          { key: option.value ?? "inherit", value: option.value ?? "" },
          option.label,
        ),
      ),
    ),
}));

const { canEditContactPermissions, ContactPermissionsSection } = await import(
  "./contact-permissions-section"
);

function contact(
  patch: Partial<ContactPayload> = {},
): ContactPayload {
  return {
    id: "c-alice",
    role: "contact",
    displayName: "Alice",
    notes: "",
    channels: [],
    interactionCount: 0,
    contactType: "human",
    autoApproveThreshold: null,
    ...patch,
  } as ContactPayload;
}

afterEach(cleanup);

describe("canEditContactPermissions", () => {
  test("allows regular human contacts", () => {
    expect(canEditContactPermissions(contact())).toBe(true);
    expect(
      canEditContactPermissions(contact({ contactType: undefined })),
    ).toBe(true);
  });

  test("hides the guardian and assistant contacts", () => {
    expect(
      canEditContactPermissions(
        contact({ role: "guardian", contactType: "human" }),
      ),
    ).toBe(false);
    expect(
      canEditContactPermissions(contact({ contactType: "assistant" })),
    ).toBe(false);
  });
});

describe("ContactPermissionsSection", () => {
  test("treats a missing or invalid ceiling as inherit", () => {
    const { rerender } = render(
      <ContactPermissionsSection
        contact={contact({ autoApproveThreshold: undefined })}
        onAutoApproveThresholdChange={() => {}}
      />,
    );

    const select = document.querySelector(
      '[data-testid="contact-permissions-select"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(document.body.textContent).toContain(
      "Follow room and trust-class settings for this contact.",
    );

    rerender(
      <ContactPermissionsSection
        contact={contact({
          autoApproveThreshold: "full" as ContactPayload["autoApproveThreshold"],
        })}
        onAutoApproveThresholdChange={() => {}}
      />,
    );
    expect(select.value).toBe("");
  });

  test("shows the stored ceiling and its description", () => {
    render(
      <ContactPermissionsSection
        contact={contact({ autoApproveThreshold: "high" })}
        onAutoApproveThresholdChange={() => {}}
      />,
    );

    const select = document.querySelector(
      '[data-testid="contact-permissions-select"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("fullAccess");
    expect(document.body.textContent).toContain(
      "Your assistant will never ask for permission.",
    );
  });

  test("emits the stored threshold, then inherit", () => {
    const changes: Array<ContactPayload["autoApproveThreshold"]> = [];
    render(
      <ContactPermissionsSection
        contact={contact()}
        onAutoApproveThresholdChange={(next) => {
          changes.push(next);
        }}
      />,
    );

    const select = document.querySelector(
      '[data-testid="contact-permissions-select"]',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "fullAccess" } });
    fireEvent.change(select, { target: { value: "" } });

    expect(changes).toEqual(["high", null]);
  });

  test("disables the picker while a save is pending", () => {
    render(
      <ContactPermissionsSection
        contact={contact()}
        pending
        onAutoApproveThresholdChange={() => {}}
      />,
    );

    const select = document.querySelector(
      '[data-testid="contact-permissions-select"]',
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});
