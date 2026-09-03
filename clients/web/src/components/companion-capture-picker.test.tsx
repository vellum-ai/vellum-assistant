import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CompanionCapturePick,
  CompanionCaptureSources,
} from "@vellumai/ipc-contract";

import { CompanionCapturePicker } from "./companion-capture-picker";

afterEach(cleanup);

const SOURCES: CompanionCaptureSources = {
  displays: [
    { kind: "display", displayId: 1, index: 0, primary: true },
    { kind: "display", displayId: 5, index: 1, primary: false },
  ],
  tabs: [
    {
      kind: "tab",
      chromeWindowId: 101,
      tabIndex: 2,
      title: "Pull request #42",
      icon: "data:image/png;base64,chrome",
    },
  ],
  windows: [
    {
      kind: "window",
      windowId: 7,
      title: "Groceries",
      app: "Notes",
      icon: "data:image/png;base64,notes",
    },
    { kind: "window", windowId: 8, title: "", app: "Preview" },
  ],
};

const rows = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? "",
  );

/**
 * The picker Teach opens: what a session could read, as a list to press.
 * Screens, then Chrome's tabs, then every other window, each named the way a
 * person would find it.
 */
describe("the capture picker", () => {
  test("draws the screens, then the tabs, then the windows", () => {
    const { container } = render(<CompanionCapturePicker sources={SOURCES} />);
    expect(rows(container)).toEqual([
      "Screen 1",
      "Screen 2",
      "Pull request #42",
      "Groceries (Notes)",
      "Preview",
    ]);
  });

  test("names each section", () => {
    const { container } = render(<CompanionCapturePicker sources={SOURCES} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Screens");
    expect(text).toContain("Chrome tabs");
    expect(text).toContain("Windows");
  });

  test("leaves out a section with nothing in it", () => {
    const { container } = render(
      <CompanionCapturePicker sources={{ ...SOURCES, tabs: [] }} />,
    );
    expect(container.textContent).not.toContain("Chrome tabs");
  });

  test("draws the app's icon where the shell read one", () => {
    const { container } = render(<CompanionCapturePicker sources={SOURCES} />);
    const images = [...container.querySelectorAll("img")].map((img) =>
      img.getAttribute("src"),
    );
    expect(images).toEqual([
      "data:image/png;base64,chrome",
      "data:image/png;base64,notes",
    ]);
  });

  test("a press is the row's pick, with its decoration removed", () => {
    const picks: CompanionCapturePick[] = [];
    const { container } = render(
      <CompanionCapturePicker
        sources={SOURCES}
        onPick={(pick) => {
          picks.push(pick);
        }}
      />,
    );
    for (const label of ["Screen 2", "Pull request #42", "Groceries (Notes)"]) {
      fireEvent.click(
        container.querySelector(`button[aria-label="${label}"]`)!,
      );
    }
    expect(picks).toEqual([
      { kind: "display", displayId: 5 },
      { kind: "tab", chromeWindowId: 101, tabIndex: 2 },
      { kind: "window", windowId: 7 },
    ]);
  });

  test("says so when the desktop has nothing to read", () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={{ displays: [], tabs: [], windows: [] }}
      />,
    );
    expect(container.textContent).toContain("Nothing to show");
    expect(rows(container)).toEqual([]);
  });

  test("is drawn, empty, while the shell is still being asked", () => {
    const { container } = render(<CompanionCapturePicker sources={null} />);
    expect(
      container.querySelector("[data-companion-capture-picker]"),
    ).not.toBeNull();
    expect(rows(container)).toEqual([]);
    expect(container.textContent).not.toContain("Nothing to show");
  });

  test("hands its card out for the host to hit-test", () => {
    let card: HTMLDivElement | null = null;
    render(
      <CompanionCapturePicker
        sources={SOURCES}
        cardRef={(element) => {
          card = element;
        }}
      />,
    );
    expect(card).not.toBeNull();
  });

  /**
   * Reopening the picker on a session already running is answered from the
   * live target, not a blank choice.
   */
  test("marks the target a running session is reading", () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={SOURCES}
        current={{ kind: "window", windowId: 7 }}
      />,
    );
    const current = container.querySelector('button[aria-pressed="true"]');
    expect(current?.getAttribute("aria-label")).toBe("Groceries (Notes)");
    const others = [
      ...container.querySelectorAll('button[aria-pressed="false"]'),
    ]
      .map((button) => button.getAttribute("aria-label"))
      .sort();
    expect(others).toEqual(
      ["Screen 1", "Screen 2", "Pull request #42", "Preview"].sort(),
    );
  });

  /**
   * A tab is never marked current: the host reports back the window a picked
   * tab resolved to, not the tab itself, so there is nothing here to compare
   * a tab row against.
   */
  test("never marks a tab, since the host reports back its window instead", () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={SOURCES}
        current={{ kind: "display", displayId: 1 }}
      />,
    );
    const tab = container.querySelector(
      'button[aria-label="Pull request #42"]',
    );
    expect(tab?.getAttribute("aria-pressed")).toBe("false");
  });

  test("stands in for the list with its own shape while loading", () => {
    const { container } = render(<CompanionCapturePicker sources={null} />);
    expect(
      container.querySelectorAll("[aria-hidden] .animate-pulse").length,
    ).toBeGreaterThan(0);
  });
});
