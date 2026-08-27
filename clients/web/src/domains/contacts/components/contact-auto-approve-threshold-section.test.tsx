import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ContactPayload } from "@/domains/contacts/types";
import type { RiskThreshold } from "@/utils/threshold-presets";

mock.module("@vellumai/design-library/components/select", () => ({
  Select: ({
    value,
    onChange,
    onSelectNone,
    options,
    disabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    value: string | null;
    onChange: (next: string) => void;
    onSelectNone?: () => void;
    options: Array<{ value: string | null; label: string }>;
    disabled?: boolean;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      value={value ?? ""}
      onChange={(event) => {
        if (event.target.value === "") {
          onSelectNone?.();
          return;
        }
        onChange(event.target.value);
      }}
    >
      {options.map((option) => (
        <option key={option.value ?? "inherit"} value={option.value ?? ""}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const { ContactAutoApproveThresholdSection } = await import(
  "@/domains/contacts/components/contact-auto-approve-threshold-section"
);

function contact(overrides: Partial<ContactPayload> = {}): ContactPayload {
  return {
    id: "contact-1",
    role: "contact",
    displayName: "Alice",
    notes: "",
    channels: [],
    interactionCount: 0,
    contactType: null,
    autoApproveThreshold: null,
    ...overrides,
  } as ContactPayload;
}

function picker(): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>(
    '[data-testid="contact-auto-approve-threshold"]',
  );
  if (!el) {
    throw new Error("expected the assistant-access picker");
  }
  return el;
}

afterEach(() => {
  cleanup();
});

describe("ContactAutoApproveThresholdSection", () => {
  test("treats a missing or invalid ceiling as inherit", () => {
    const { rerender } = render(
      <ContactAutoApproveThresholdSection
        contact={contact({ autoApproveThreshold: undefined })}
        pending={false}
        onChange={() => {}}
      />,
    );

    expect(picker().value).toBe("");
    expect(document.body.textContent).toContain(
      "Follow room and trust-class settings for this contact.",
    );

    rerender(
      <ContactAutoApproveThresholdSection
        contact={contact({
          autoApproveThreshold: "full" as unknown as RiskThreshold,
        })}
        pending={false}
        onChange={() => {}}
      />,
    );
    expect(picker().value).toBe("");
  });

  test("shows the stored ceiling and its description", () => {
    render(
      <ContactAutoApproveThresholdSection
        contact={contact({ autoApproveThreshold: "high" })}
        pending={false}
        onChange={() => {}}
      />,
    );

    expect(picker().value).toBe("high");
    expect(document.body.textContent).toContain("Assistant access");
    expect(document.body.textContent).toContain(
      "Auto-approve all actions, including high-risk and unrecognized commands.",
    );
  });

  test("emits the chosen ceiling, or null when inherit is picked", () => {
    const changes: Array<RiskThreshold | null> = [];
    render(
      <ContactAutoApproveThresholdSection
        contact={contact({ autoApproveThreshold: null })}
        pending={false}
        onChange={(next) => {
          changes.push(next);
        }}
      />,
    );

    fireEvent.change(picker(), { target: { value: "high" } });
    fireEvent.change(picker(), { target: { value: "" } });

    expect(changes).toEqual(["high", null]);
  });

  test("disables the picker while a save is in flight", () => {
    render(
      <ContactAutoApproveThresholdSection
        contact={contact()}
        pending
        onChange={() => {}}
      />,
    );

    expect(picker().disabled).toBe(true);
  });
});
