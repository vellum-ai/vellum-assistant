import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

const isMobileRef = { value: false };
const nativeIOSRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeIOS: () => nativeIOSRef.value,
}));

const { CommandPalette } =
  await import("@/components/command-palette/command-palette");

afterEach(() => {
  cleanup();
  isMobileRef.value = false;
  nativeIOSRef.value = false;
});

const SECTIONS = [
  {
    id: "actions",
    label: "Actions",
    items: [{ id: "new", title: "New Conversation" }],
  },
];

function paletteElement(isOpen: boolean) {
  return (
    <CommandPalette
      isOpen={isOpen}
      onClose={() => undefined}
      query=""
      onQueryChange={() => undefined}
      selectedIndex={0}
      sections={SECTIONS}
      onKeyDown={() => undefined}
    />
  );
}

function renderPalette(isOpen: boolean) {
  return render(paletteElement(isOpen));
}

describe("CommandPalette", () => {
  test("uses compact desktop styling inside the floating window even at mobile widths", () => {
    isMobileRef.value = true;

    render(
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => undefined}
        query=""
        onQueryChange={() => undefined}
        selectedIndex={0}
        sections={SECTIONS}
        onKeyDown={() => undefined}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog.className).toContain("bg-transparent");
    expect(dialog.className).not.toContain("absolute");

    const panel = dialog.firstElementChild as HTMLElement | null;
    expect(panel?.className).toContain("bg-[var(--surface-base)]");

    const selected = screen.getByRole("option", { selected: true });
    expect(selected.className).toContain("h-10");
    expect(selected.className).toContain("text-sm");
  });

  test("renders search results as a two-line row with title and snippet", () => {
    render(
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => undefined}
        query="alpha"
        onQueryChange={() => undefined}
        selectedIndex={0}
        sections={[
          {
            id: "search-conversations",
            label: "Conversations",
            items: [
              {
                id: "search-conv-c1",
                title: "Trip planning",
                snippet: "…we compared alpha and beta itineraries…",
              },
            ],
          },
        ]}
        onKeyDown={() => undefined}
      />,
    );

    const row = screen.getByRole("option");
    expect(row.className).not.toContain("h-10");
    expect(row.textContent).toContain("Trip planning");
    expect(row.textContent).toContain("we compared alpha and beta");
  });

  test("highlights via the server term when the input contains search filters", () => {
    render(
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => undefined}
        query="is:archived alpha"
        onQueryChange={() => undefined}
        highlightTokens={["alpha"]}
        selectedIndex={0}
        sections={[
          {
            id: "search-conversations",
            label: "Conversations",
            items: [
              {
                id: "search-conv-c1",
                title: "Trip planning",
                snippet: "…we compared alpha and beta itineraries…",
              },
            ],
          },
        ]}
        onKeyDown={() => undefined}
      />,
    );

    const row = screen.getByRole("option");
    const highlight = row.querySelector("span.font-medium");
    expect(highlight?.textContent).toBe("alpha");
  });

  test("highlights each token independently for multi-token queries", () => {
    render(
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => undefined}
        query="alpha beta"
        onQueryChange={() => undefined}
        highlightTokens={["alpha", "beta"]}
        selectedIndex={0}
        sections={[
          {
            id: "search-conversations",
            label: "Conversations",
            items: [
              {
                id: "search-conv-c1",
                title: "Trip planning",
                snippet: "…we compared alpha and beta itineraries…",
              },
            ],
          },
        ]}
        onKeyDown={() => undefined}
      />,
    );

    const row = screen.getByRole("option");
    const highlights = [...row.querySelectorAll("span.font-medium")];
    expect(highlights.map((el) => el.textContent)).toEqual(["alpha", "beta"]);
  });

  test("does not highlight token substrings inside larger words", () => {
    render(
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => undefined}
        query="alpha art"
        onQueryChange={() => undefined}
        highlightTokens={["alpha", "art"]}
        selectedIndex={0}
        sections={[
          {
            id: "search-conversations",
            label: "Conversations",
            items: [
              {
                id: "search-conv-c1",
                title: "Trip planning",
                snippet: "party starts before alpha",
              },
            ],
          },
        ]}
        onKeyDown={() => undefined}
      />,
    );

    const row = screen.getByRole("option");
    const highlights = [...row.querySelectorAll("span.font-medium")];
    expect(highlights.map((el) => el.textContent)).toEqual(["alpha"]);
  });

  test("keeps highlight offsets aligned when lowercasing changes string length", () => {
    render(
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => undefined}
        query="alpha"
        onQueryChange={() => undefined}
        highlightTokens={["alpha"]}
        selectedIndex={0}
        sections={[
          {
            id: "search-conversations",
            label: "Conversations",
            items: [
              {
                id: "search-conv-c1",
                title: "Travel notes",
                snippet: "İstanbul alpha itinerary",
              },
            ],
          },
        ]}
        onKeyDown={() => undefined}
      />,
    );

    const row = screen.getByRole("option");
    const highlight = row.querySelector("span.font-medium");
    expect(highlight?.textContent).toBe("alpha");
  });

  test("renders nothing while closed outside the iOS shell", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = false;

    renderPalette(false);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("unmounts the sheet synchronously on close outside the iOS shell", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = false;

    const { rerender } = renderPalette(true);
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();

    rerender(paletteElement(false));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("keeps the sheet in the DOM after close in the iOS shell", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = true;

    const { rerender } = renderPalette(true);
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();

    rerender(paletteElement(false));

    // The load-bearing behavior: AnimatePresence holds the sheet in the DOM
    // while the exit plays, so the chat underneath stays covered.
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  });

  test("stops taking taps and announcing itself while the exit plays", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = true;

    const { rerender } = renderPalette(true);
    const sheet = screen.getByRole("dialog", { name: "Search" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.style.pointerEvents).toBe("");

    rerender(paletteElement(false));

    // The sheet still covers the viewport for the length of the exit, so the
    // chat and drawer underneath have to stay reachable.
    expect(sheet.style.pointerEvents).toBe("none");
    expect(sheet.getAttribute("aria-hidden")).toBe("true");
    expect(sheet.hasAttribute("aria-modal")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("releases focus held inside the sheet when the exit starts", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = true;

    const { rerender } = renderPalette(true);
    const input = screen.getByRole("textbox", { name: "Search" });
    input.focus();
    expect(document.activeElement).toBe(input);

    rerender(paletteElement(false));

    // Blurring here starts the iOS keyboard dismissal alongside the slide-out.
    expect(document.activeElement).not.toBe(input);
  });

  test("leaves focus outside the sheet alone when the exit starts", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = true;

    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    const { rerender } = renderPalette(true);

    composer.focus();
    rerender(paletteElement(false));

    // Selecting "New Conversation" focuses the composer before the palette
    // closes, so the close must not take that focus back.
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  test("renders the mobile sheet affordances in the iOS shell", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = true;

    renderPalette(true);

    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close search" })).toBeTruthy();
  });
});
