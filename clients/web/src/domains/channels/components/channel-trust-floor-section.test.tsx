/**
 * The trust-floor dropdown's confirmation gate.
 *
 * The gate lives on the control itself so every surface that renders a floor
 * dropdown (built-in adapter panels, the plugin channel panel) confirms the
 * same way. What these tests protect is that a loosening or hard-denying
 * floor can never reach `onChange` without a confirmed dialog, whoever the
 * caller is.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ChannelTrustFloorSection } from "@/domains/channels/components/channel-trust-floor-section";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";

function renderSection(policy: AdmissionPolicy = "trusted_contacts") {
  const onChange = mock((_policy: AdmissionPolicy) => {});
  render(
    <ChannelTrustFloorSection
      assistantDisplayName="Vex"
      policy={policy}
      onChange={onChange}
    />,
  );
  return onChange;
}

function openMenu(): HTMLElement[] {
  const trigger = document.querySelector<HTMLElement>(
    '[data-slot="select-trigger"]',
  );
  if (!trigger) {
    throw new Error("No select trigger rendered");
  }
  fireEvent.click(trigger);
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function optionLabeled(options: HTMLElement[], label: string): HTMLElement {
  const match = options.find((el) => el.textContent?.startsWith(label));
  if (!match) {
    const seen = options.map((el) => el.textContent).join(", ");
    throw new Error(`No option labeled "${label}" (saw: ${seen})`);
  }
  return match;
}

const confirmButton = () =>
  document.querySelector<HTMLButtonElement>("[data-confirm-dialog-confirm]");

afterEach(() => {
  cleanup();
});

describe("ChannelTrustFloorSection confirmation gate", () => {
  test("strangers persists only after the dialog is confirmed", () => {
    const onChange = renderSection();

    fireEvent.click(optionLabeled(openMenu(), "Strangers"));

    // Picking the floor alone must not persist it.
    expect(onChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Allow strangers?");

    fireEvent.click(confirmButton()!);
    expect(onChange.mock.calls).toEqual([["strangers"]]);
  });

  test("cancel discards the pick without persisting anything", () => {
    const onChange = renderSection();

    fireEvent.click(optionLabeled(openMenu(), "Any contact"));
    expect(document.body.textContent).toContain("Allow any contact?");

    const cancel = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Cancel",
    );
    expect(cancel).toBeDefined();
    fireEvent.click(cancel!);

    expect(onChange).not.toHaveBeenCalled();
  });

  test.each<[AdmissionPolicy, string, string]>([
    ["no_one", "No one", "Block all messages?"],
    ["any_contact", "Any contact", "Allow any contact?"],
    ["strangers", "Strangers", "Allow strangers?"],
  ])("%s is gated behind its dialog", (_floor, label, title) => {
    const onChange = renderSection();

    fireEvent.click(optionLabeled(openMenu(), label));

    expect(onChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(title);
  });

  test("a tightening floor applies immediately, no dialog", () => {
    const onChange = renderSection("strangers");

    fireEvent.click(optionLabeled(openMenu(), "Only you"));

    expect(onChange.mock.calls).toEqual([["guardian_only"]]);
    expect(confirmButton()).toBeNull();
  });
});
