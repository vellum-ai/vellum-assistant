import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CompanionCapturePick,
  CompanionCaptureSources,
  WatchCaptureTarget,
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

/** What the grid is offering, by the name a reader hears. */
const tiles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-slot="capture-source"]')].map(
    (tile) => tile.getAttribute("aria-label") ?? "",
  );

/** The segments, by the name on them. */
const kinds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-slot="capture-kinds"] button')].map(
    (button) => button.textContent ?? "",
  );

const pressKind = (container: HTMLElement, name: string): void => {
  const button = [
    ...container.querySelectorAll('[data-slot="capture-kinds"] button'),
  ].find((each) => each.textContent === name);
  fireEvent.click(button!);
};

/** What each tile has in its picture slot, be it a picture or a stand-in. */
const pictures = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll('[data-slot="capture-preview"] img')].map(
    (img) => img.getAttribute("src"),
  );

/** A host that answers every tile with a picture named after its target. */
const answering = (target: WatchCaptureTarget): Promise<string | null> =>
  Promise.resolve(
    target.kind === "display"
      ? `data:image/jpeg;base64,display-${target.displayId}`
      : `data:image/jpeg;base64,window-${target.windowId}`,
  );

/** Lets the pictures the host already resolved reach the tiles. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/**
 * The picker Teach and Share open: what a session could read, as a grid of
 * what those things currently look like, one kind at a time.
 */
describe("the capture picker", () => {
  test("opens on the screens, drawn as tiles", () => {
    const { container } = render(<CompanionCapturePicker sources={SOURCES} />);
    expect(tiles(container)).toEqual(["Screen 1", "Screen 2"]);
  });

  test("offers each kind the desktop has, in the order a choice narrows", () => {
    const { container } = render(<CompanionCapturePicker sources={SOURCES} />);
    expect(kinds(container)).toEqual(["Screens", "Chrome tabs", "Windows"]);
  });

  test("leaves out a kind with nothing in it", () => {
    const { container } = render(
      <CompanionCapturePicker sources={{ ...SOURCES, tabs: [] }} />,
    );
    expect(kinds(container)).toEqual(["Screens", "Windows"]);
  });

  test("offers no choice at all when the desktop has one kind on it", () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={{ ...SOURCES, displays: [], tabs: [] }}
      />,
    );
    expect(kinds(container)).toEqual([]);
    expect(tiles(container)).toEqual(["Groceries (Notes)", "Preview"]);
  });

  test("opens on what the desktop does have when there are no screens", () => {
    const { container } = render(
      <CompanionCapturePicker sources={{ ...SOURCES, displays: [] }} />,
    );
    expect(tiles(container)).toEqual(["Pull request #42"]);
  });

  test("a segment is the kind the grid draws", () => {
    const { container } = render(<CompanionCapturePicker sources={SOURCES} />);
    pressKind(container, "Windows");
    expect(tiles(container)).toEqual(["Groceries (Notes)", "Preview"]);
    pressKind(container, "Chrome tabs");
    expect(tiles(container)).toEqual(["Pull request #42"]);
  });

  test("says which segment is on", () => {
    const { container } = render(<CompanionCapturePicker sources={SOURCES} />);
    const checked = (): (string | null)[] =>
      [...container.querySelectorAll('[data-slot="capture-kinds"] button')].map(
        (button) => button.getAttribute("aria-checked"),
      );
    expect(checked()).toEqual(["true", "false", "false"]);
    pressKind(container, "Windows");
    expect(checked()).toEqual(["false", "false", "true"]);
  });

  test("draws each screen and window as a picture of itself", async () => {
    const { container } = render(
      <CompanionCapturePicker sources={SOURCES} captureThumbnail={answering} />,
    );
    await settle();
    expect(pictures(container)).toEqual([
      "data:image/jpeg;base64,display-1",
      "data:image/jpeg;base64,display-5",
    ]);
    pressKind(container, "Windows");
    await settle();
    expect(pictures(container)).toEqual([
      "data:image/jpeg;base64,window-7",
      "data:image/jpeg;base64,window-8",
    ]);
  });

  test("asks for a picture once, however often the kind is switched", async () => {
    const asked: WatchCaptureTarget[] = [];
    const { container } = render(
      <CompanionCapturePicker
        sources={SOURCES}
        captureThumbnail={(target) => {
          asked.push(target);
          return answering(target);
        }}
      />,
    );
    await settle();
    pressKind(container, "Windows");
    await settle();
    pressKind(container, "Screens");
    await settle();
    expect(asked).toEqual([
      { kind: "display", displayId: 1 },
      { kind: "display", displayId: 5 },
      { kind: "window", windowId: 7 },
      { kind: "window", windowId: 8 },
    ]);
  });

  test("never asks for a picture of a tab", async () => {
    const asked: WatchCaptureTarget[] = [];
    const { container } = render(
      <CompanionCapturePicker
        sources={{ ...SOURCES, displays: [] }}
        captureThumbnail={(target) => {
          asked.push(target);
          return answering(target);
        }}
      />,
    );
    await settle();
    expect(tiles(container)).toEqual(["Pull request #42"]);
    expect(asked).toEqual([]);
  });

  test("settles a tile the host could take no picture of on its icon", async () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={{ ...SOURCES, displays: [], tabs: [] }}
        captureThumbnail={() => Promise.resolve(null)}
      />,
    );
    await settle();
    expect(pictures(container)).toEqual(["data:image/png;base64,notes"]);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  test("draws a tile as waiting only until the host has answered it", async () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={{ ...SOURCES, displays: [], tabs: [] }}
        captureThumbnail={answering}
      />,
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
    await settle();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  test("waits on nothing where the shell cannot take pictures", () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={{ ...SOURCES, displays: [], tabs: [] }}
      />,
    );
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(pictures(container)).toEqual(["data:image/png;base64,notes"]);
  });

  test("draws the app's icon beside a window's name", () => {
    const { container } = render(
      <CompanionCapturePicker
        sources={{ ...SOURCES, displays: [], tabs: [] }}
      />,
    );
    // Twice for the window with an icon: standing in for its missing picture,
    // and beside its name. The window without one draws neither.
    expect(pictures(container)).toEqual(["data:image/png;base64,notes"]);
    expect(
      container.querySelectorAll('img[src="data:image/png;base64,notes"]'),
    ).toHaveLength(2);
  });

  test("a press is the tile's pick, with its decoration removed", () => {
    const picks: CompanionCapturePick[] = [];
    const { container } = render(
      <CompanionCapturePicker
        sources={SOURCES}
        onPick={(pick) => {
          picks.push(pick);
        }}
      />,
    );
    fireEvent.click(container.querySelector('button[aria-label="Screen 2"]')!);
    pressKind(container, "Chrome tabs");
    fireEvent.click(
      container.querySelector('button[aria-label="Pull request #42"]')!,
    );
    pressKind(container, "Windows");
    fireEvent.click(
      container.querySelector('button[aria-label="Groceries (Notes)"]')!,
    );
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
    expect(tiles(container)).toEqual([]);
    expect(kinds(container)).toEqual([]);
  });

  test("is drawn, empty, while the shell is still being asked", () => {
    const { container } = render(<CompanionCapturePicker sources={null} />);
    expect(
      container.querySelector("[data-companion-capture-picker]"),
    ).not.toBeNull();
    expect(tiles(container)).toEqual([]);
    expect(kinds(container)).toEqual([]);
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

  test("stands in for the grid with its own shape while loading", () => {
    const { container } = render(<CompanionCapturePicker sources={null} />);
    expect(
      container.querySelectorAll("[aria-hidden] .animate-pulse").length,
    ).toBeGreaterThan(0);
  });
});
