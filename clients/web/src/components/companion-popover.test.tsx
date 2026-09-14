import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type {
  CompanionPopover as CompanionPopoverContent,
  CompanionPopoverAnswer,
} from "@vellumai/ipc-contract";

import {
  CompanionPopover,
  drawsImageSource,
} from "@/components/companion-popover";

const APPROVAL: CompanionPopoverContent = {
  kind: "approval",
  id: "req-1",
  title: "Listing your files",
  detail: "Reads your home folder",
};

const CARD: CompanionPopoverContent = {
  kind: "card",
  id: "surf-1",
  title: "The Eiffel Tower",
  subtitle: "Paris",
  body: "![tower](https://example.com/tower.jpg)\n\n![inline](data:image/png;base64,AAAA)\n\n![local](vellum://workspace/a.png)\n\n[Tickets](https://example.com/tickets)",
  actions: [{ id: "book", label: "Book", style: "primary" }],
};

const buttonOf = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) =>
      button.textContent === name || button.getAttribute("aria-label") === name,
  ) ?? null;

const renderWith = (popover: CompanionPopoverContent) => {
  const answers: CompanionPopoverAnswer[] = [];
  const links: string[] = [];
  const view = render(
    <CompanionPopover
      popover={popover}
      assistantName="Ziggy"
      onAnswer={(answer) => {
        answers.push(answer);
      }}
      onOpenLink={(url) => {
        links.push(url);
      }}
    />,
  );
  return { ...view, answers, links };
};

afterEach(() => {
  cleanup();
});

describe("the popover beside the companion", () => {
  test("puts an approval to the user with every answer", () => {
    const { container, answers } = renderWith(APPROVAL);

    expect(container.textContent).toContain("Listing your files");
    expect(container.textContent).toContain("Reads your home folder");
    fireEvent.click(buttonOf(container, "Allow")!);
    fireEvent.click(buttonOf(container, "Deny")!);
    fireEvent.click(buttonOf(container, "Open Vellum")!);

    expect(answers).toEqual([
      { kind: "allow" },
      { kind: "deny" },
      { kind: "open" },
    ]);
  });

  /** The turn is waiting on it, so there is no way to wave it off. */
  test("offers no dismissal on an approval", () => {
    const { container } = renderWith(APPROVAL);

    expect(buttonOf(container, "Dismiss")).toBeNull();
  });

  test("allows a permission request by opening its pane", () => {
    const { container, answers } = renderWith({
      ...APPROVAL,
      permission: "screen",
    });

    fireEvent.click(buttonOf(container, "Allow and open Settings")!);

    expect(answers).toEqual([{ kind: "settings" }]);
  });

  test("draws a card's images from the web and nothing it cannot fetch", () => {
    const { container } = renderWith(CARD);

    const sources = Array.from(container.querySelectorAll("img")).map((img) =>
      img.getAttribute("src"),
    );
    expect(sources).toEqual([
      "https://example.com/tower.jpg",
      "data:image/png;base64,AAAA",
    ]);
  });

  test("opens a card's links through the page rather than navigating", () => {
    const { container, links } = renderWith(CARD);

    const anchor = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent === "Tickets",
    );
    fireEvent.click(anchor!);

    expect(links).toEqual(["https://example.com/tickets"]);
  });

  test("runs a card's actions and dismisses it", () => {
    const { container, answers } = renderWith(CARD);

    fireEvent.click(buttonOf(container, "Book")!);
    fireEvent.click(buttonOf(container, "Dismiss")!);

    expect(answers).toEqual([
      { kind: "action", actionId: "book" },
      { kind: "dismiss" },
    ]);
  });

  test("names a surface it cannot draw with a way into the app", () => {
    const { container, answers } = renderWith({
      kind: "surface",
      id: "form-1",
      title: "Shipping address",
    });

    expect(container.textContent).toContain("Shipping address");
    fireEvent.click(buttonOf(container, "Open Vellum")!);

    expect(answers).toEqual([{ kind: "open" }]);
  });
});

describe("drawsImageSource", () => {
  test("draws the web and inline images", () => {
    expect(drawsImageSource("https://example.com/a.png")).toBe(true);
    expect(drawsImageSource("data:image/png;base64,AAAA")).toBe(true);
  });

  test("refuses anything that needs the app's session or the disk", () => {
    expect(drawsImageSource("vellum://workspace/a.png")).toBe(false);
    expect(drawsImageSource("/Users/example/a.png")).toBe(false);
    expect(drawsImageSource("data:text/html,<b>")).toBe(false);
    expect(drawsImageSource("")).toBe(false);
  });
});
