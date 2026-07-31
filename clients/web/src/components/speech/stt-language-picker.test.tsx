/**
 * Tests for the shared search-first language picker: the grouped rendering,
 * the search filter and its keyboard contract (type to filter, arrows to
 * highlight, Enter to pick), and the modal wrapper's focus/close behavior.
 * Rendered through `SttLanguagePickerModal` (the settings form's and voice
 * room's host); the first-run card hosts the same content component and has
 * its own tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SttLanguagePickerModal } from "@/components/speech/stt-language-picker-modal";

let picks: string[] = [];
let openChanges: boolean[] = [];

function renderPicker(
  props: Partial<Parameters<typeof SttLanguagePickerModal>[0]> = {},
) {
  return render(
    <SttLanguagePickerModal
      open
      onOpenChange={(open) => openChanges.push(open)}
      title="Listening language"
      currentCode=""
      configuredProviderId="vellum"
      selectLanguage={(code) => picks.push(code)}
      selecting={false}
      {...props}
    />,
  );
}

function searchInput(): HTMLInputElement {
  return screen.getByRole("combobox", {
    name: "Search languages",
  }) as HTMLInputElement;
}

function optionLabels(): string[] {
  return screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

beforeEach(() => {
  picks = [];
  openChanges = [];
});

afterEach(() => cleanup());

describe("SttLanguagePicker (in its modal host)", () => {
  test("renders the Featured group and the A-Z remainder under their headers", () => {
    renderPicker();
    expect(screen.getByText("Featured")).toBeTruthy();
    expect(screen.getByText("All languages")).toBeTruthy();
    // Featured for a fresh multi-capable config: the default row, then
    // Multilingual; the extended roster sits in the A-Z remainder.
    const labels = optionLabels();
    expect(labels[0]).toContain("English (default)");
    expect(labels[1]).toContain("Multilingual");
    expect(labels[2]).toContain("Arabic");
    expect(labels.some((label) => label.includes("Tamil"))).toBe(true);
  });

  test("focus lands in the search field on open", () => {
    renderPicker();
    expect(document.activeElement).toBe(searchInput());
  });

  test("the current selection is marked selected", () => {
    renderPicker({ currentCode: "es" });
    const spanish = screen.getByRole("option", { name: /Spanish \(Español\)/ });
    expect(spanish.getAttribute("aria-selected")).toBe("true");
    // Featured pins the current value first.
    expect(optionLabels()[0]).toContain("Spanish");
  });

  test("the locale suggestion joins Featured with the Suggested annotation", () => {
    renderPicker({ suggestedCode: "multi" });
    const multilingual = screen.getByRole("option", { name: /Multilingual/ });
    expect(multilingual.textContent).toContain("Suggested");
  });

  test("typing filters to a flat list and hides the group headers", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(searchInput(), "ta");
    const labels = optionLabels();
    expect(labels.some((label) => label.includes("Tamil"))).toBe(true);
    expect(labels.some((label) => label.includes("Tagalog"))).toBe(true);
    expect(labels.some((label) => label.includes("French"))).toBe(false);
    expect(screen.queryByText("Featured")).toBeNull();
    expect(screen.queryByText("All languages")).toBeNull();
  });

  test("Enter picks the first match while filtering and closes", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(searchInput(), "tamil");
    expect(optionLabels()).toEqual(["Tamil (தமிழ்)"]);
    await user.keyboard("{Enter}");
    expect(picks).toEqual(["ta"]);
    // A pick hot-applies (nothing to save), so it also closes the modal.
    expect(openChanges).toEqual([false]);
  });

  test("arrows move the highlight from the search field and Enter picks it", async () => {
    const user = userEvent.setup();
    renderPicker();
    // Focus never leaves the input; the highlight is announced through
    // aria-activedescendant.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(searchInput());
    const activeId = searchInput().getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    const active = document.getElementById(activeId!);
    // Two steps from the top of the visible list: default row, then
    // Multilingual.
    expect(active?.textContent).toContain("Multilingual");
    await user.keyboard("{Enter}");
    expect(picks).toEqual(["multi"]);
    expect(openChanges).toEqual([false]);
  });

  test("Enter with no highlight and no query picks nothing", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard("{Enter}");
    expect(picks).toEqual([]);
    expect(openChanges).toEqual([]);
  });

  test("a query with no matches says so instead of rendering options", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(searchInput(), "klingon");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No languages match.")).toBeTruthy();
  });

  test("clicking an option picks it and closes", () => {
    renderPicker();
    fireEvent.click(
      screen.getByRole("option", { name: /French \(Français\)/ }),
    );
    expect(picks).toEqual(["fr"]);
    expect(openChanges).toEqual([false]);
  });

  test("Escape closes the modal", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard("{Escape}");
    expect(openChanges).toEqual([false]);
  });

  test("the list dims while a write is in flight but keeps its options", () => {
    renderPicker({ selecting: true });
    expect(
      screen
        .getByRole("listbox", { name: "Languages" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  test("an xai provider offers no Multilingual row and no extended roster", () => {
    renderPicker({ configuredProviderId: "xai" });
    const labels = optionLabels();
    expect(labels.some((label) => label.includes("Multilingual"))).toBe(false);
    expect(labels.some((label) => label.includes("Tamil"))).toBe(false);
    expect(labels[0]).toContain("Auto-detect (default)");
  });
});
