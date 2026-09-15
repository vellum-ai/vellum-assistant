import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type {
  CompanionPopover as CompanionPopoverContent,
  CompanionPopoverAnswer,
  CompanionPopoverView,
} from "@vellumai/ipc-contract";

import {
  CompanionPopover,
  drawsImageSource,
} from "@/components/companion-popover";

const ONE: CompanionPopoverContent = {
  kind: "approvals",
  id: "req-1",
  items: [
    {
      id: "req-1",
      title: "Need your permission accessing the Downloads folder",
      detail: "Reads your Downloads folder",
    },
  ],
};

const THREE: CompanionPopoverContent = {
  kind: "approvals",
  id: "req-1,req-2,req-3",
  items: [
    { id: "req-1", title: "Read the Downloads folder", detail: "" },
    { id: "req-2", title: "Open Safari", detail: "" },
    { id: "req-3", title: "Send an email", detail: "" },
  ],
};

const SECRET: CompanionPopoverContent = {
  kind: "secret",
  id: "sec-1",
  service: "Booking.com",
  providerKey: "booking_com",
  detail: "To sign in and check your reservation.",
  label: "Password",
  placeholder: "Type your booking password",
};

const CARD: CompanionPopoverContent = {
  kind: "card",
  id: "surf-1",
  title: "The Eiffel Tower",
  subtitle: "Paris",
  body: "![tower](https://example.com/tower.jpg)\n\n![inline](data:image/png;base64,AAAA)\n\n![local](vellum://workspace/a.png)\n\n[Tickets](https://example.com/tickets)",
  actions: [{ id: "book", label: "Book", style: "primary" }],
};

const buttonsNamed = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll("button")).filter(
    (button) =>
      button.textContent === name || button.getAttribute("aria-label") === name,
  );

const buttonOf = (container: HTMLElement, name: string) =>
  buttonsNamed(container, name)[0] ?? null;

const renderWith = (
  popover: CompanionPopoverContent,
  view: CompanionPopoverView = "row",
) => {
  const answers: CompanionPopoverAnswer[] = [];
  const views: CompanionPopoverView[] = [];
  const links: string[] = [];
  const result = render(
    <CompanionPopover
      popover={popover}
      view={view}
      assistantName="Ziggy"
      onAnswer={(answer) => {
        answers.push(answer);
      }}
      onView={(next) => {
        views.push(next);
      }}
      onOpenLink={(url) => {
        links.push(url);
      }}
    />,
  );
  return { ...result, answers, views, links };
};

afterEach(() => {
  cleanup();
});

describe("the popover's approvals", () => {
  test("asks a single approval in a row with its own answers", () => {
    const { container, answers } = renderWith(ONE);

    expect(container.textContent).toContain(
      "Need your permission accessing the Downloads folder",
    );
    fireEvent.click(buttonOf(container, "Allow")!);
    fireEvent.click(buttonOf(container, "Deny")!);

    expect(answers).toEqual([
      { kind: "allow", itemId: "req-1" },
      { kind: "deny", itemId: "req-1" },
    ]);
  });

  test("a permission request's allow opens its pane too", () => {
    const { container, answers } = renderWith({
      ...ONE,
      items: [{ ...ONE.items[0], permission: "screen" }],
    } as CompanionPopoverContent);

    fireEvent.click(buttonOf(container, "Allow")!);

    expect(answers).toEqual([{ kind: "settings", itemId: "req-1" }]);
  });

  test("sums several up with a way to review them or put them off", () => {
    const { container, views, answers } = renderWith(THREE);

    expect(container.textContent).toContain("Need your OK on 3 things");
    expect(buttonOf(container, "Allow")).toBeNull();
    fireEvent.click(buttonOf(container, "Review")!);
    fireEvent.click(buttonOf(container, "Not Now")!);

    expect(views).toEqual(["expanded", "deferred"]);
    expect(answers).toEqual([]);
  });

  test("lists them numbered once reviewed, each answered on its own row", () => {
    const { container, answers } = renderWith(THREE, "expanded");

    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "1Read the Downloads folderAllowDeny",
      "2Open SafariAllowDeny",
      "3Send an emailAllowDeny",
    ]);
    fireEvent.click(buttonsNamed(container, "Deny")[1]);
    fireEvent.click(buttonsNamed(container, "Allow")[2]);

    expect(answers).toEqual([
      { kind: "deny", itemId: "req-2" },
      { kind: "allow", itemId: "req-3" },
    ]);
  });
});

describe("the popover's credential", () => {
  test("names the service with a way to enter it or put it off", () => {
    const { container, views } = renderWith(SECRET);

    expect(container.textContent).toContain("Need credentials for Booking.com");
    fireEvent.click(buttonOf(container, "Enter")!);
    fireEvent.click(buttonOf(container, "Not Now")!);

    expect(views).toEqual(["expanded", "deferred"]);
  });

  test("takes the credential in a form and sends it on Confirm", () => {
    const { container, answers } = renderWith(SECRET, "expanded");

    expect(container.textContent).toContain(
      "To sign in and check your reservation.",
    );
    const input = container.querySelector("input")!;
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("placeholder")).toBe(
      "Type your booking password",
    );
    expect(buttonOf(container, "Confirm")?.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "hunter2" } });
    fireEvent.click(buttonOf(container, "Confirm")!);

    expect(answers).toEqual([{ kind: "secret", value: "hunter2" }]);
  });
});

describe("the popover's cards", () => {
  test("draws a card's images from the web and inline, and none it cannot fetch", () => {
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
