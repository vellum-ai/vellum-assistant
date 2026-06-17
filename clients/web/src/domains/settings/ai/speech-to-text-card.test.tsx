/**
 * Tests for `SpeechToTextCard`'s "macOS Native Dictation" provider option:
 *
 *   1. The option only appears when the renderer can reach the mac helper's
 *      recognizer (the macOS Electron shell) — never on web/iOS.
 *   2. Selecting it hides the API-key field and shows the System Settings →
 *      Keyboard → Dictation prerequisite warning; Save persists the choice.
 *   3. A persisted native choice on a build without the capability falls
 *      back to the default provider instead of an empty dropdown.
 *
 * The native-dictation runtime module is mocked (its real implementation
 * imports a Vite `?worker&url` asset and probes `window.vellum`); the
 * design-library Dropdown is real, driven via its combobox trigger like
 * `provider-create-form.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let nativeDictationSupported = false;
mock.module("@/runtime/native-dictation-partials", () => ({
  isNativeDictationSupported: () => nativeDictationSupported,
}));

const { SpeechToTextCard } = await import(
  "@/domains/settings/ai/speech-to-text-card"
);
const { LS_STT_PROVIDER } = await import("@/domains/settings/ai/local-storage-keys");

function openProviderDropdown(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="STT provider"]',
  );
  if (!trigger) throw new Error("expected the STT provider dropdown trigger");
  fireEvent.click(trigger);
}

function visibleOptions(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

/** Click an option in the already-open listbox (the trigger toggles). */
function selectOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(
      `expected option "${label}" — saw: ${visibleOptions().join(", ")}`,
    );
  }
  fireEvent.click(option);
}

describe("SpeechToTextCard — macOS Native Dictation option", () => {
  beforeEach(() => {
    localStorage.clear();
    nativeDictationSupported = false;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("native option is absent when the helper recognizer is unavailable", () => {
    render(<SpeechToTextCard />);

    openProviderDropdown();
    expect(visibleOptions()).not.toContain("macOS Native Dictation");
  });

  test("selecting the native option hides the API key field and shows the Dictation warning", () => {
    nativeDictationSupported = true;
    render(<SpeechToTextCard />);

    openProviderDropdown();
    expect(visibleOptions()).toContain("macOS Native Dictation");

    selectOption("macOS Native Dictation");

    expect(screen.queryByText("API Key")).toBeNull();
    expect(
      screen.getByText(/System Settings → Keyboard, then enable Dictation/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("macos-native");
  });

  test("a stored native choice falls back to the default provider off Electron", () => {
    localStorage.setItem(LS_STT_PROVIDER, "macos-native");
    render(<SpeechToTextCard />);

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="STT provider"]',
    );
    expect(trigger?.textContent).toContain("Deepgram");
    expect(screen.getByText("API Key")).toBeTruthy();
    // The fallback must also self-heal the persisted value — leaving
    // "macos-native" behind would diverge from what the UI shows, with
    // Save disabled so the user couldn't persist the correction.
    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("deepgram");
  });

  test("a legacy provider alias is not overwritten by the self-heal", () => {
    // "whisper" predates the current catalog ids; stt-api's
    // normalizeSttProviderId() still maps it at transcribe time, so merely
    // opening Settings must not rewrite it.
    localStorage.setItem(LS_STT_PROVIDER, "whisper");
    render(<SpeechToTextCard />);

    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("whisper");
  });
});
