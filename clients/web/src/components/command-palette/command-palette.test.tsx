import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// Shortcut hints follow the host OS; pin macOS so the glyph assertions below
// hold on Linux CI runners too.
Object.defineProperty(navigator, "platform", {
  value: "MacIntel",
  configurable: true,
});
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";

const isMobileRef = { value: false };
const nativeMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeMobile: () => nativeMobileRef.value,
}));

const { CommandPalette } =
  await import("@/components/command-palette/command-palette");

afterEach(() => {
  cleanup();
  isMobileRef.value = false;
  nativeMobileRef.value = false;
});

const SECTIONS = [
  {
    id: "actions",
    label: "Actions",
    items: [{ id: "new", title: "New Conversation" }],
  },
];

/** The same Actions row, carrying a chord hint the app really ships. */
const HINTED_SECTIONS = [
  {
    id: "actions",
    label: "Actions",
    items: [
      { id: "new", title: "New Conversation", shortcutHint: "⌘⇧O" },
      { id: "library", title: "Library" },
    ],
  },
];

function paletteElement(isOpen: boolean, sections = SECTIONS) {
  return (
    <CommandPalette
      isOpen={isOpen}
      onClose={() => undefined}
      query=""
      onQueryChange={() => undefined}
      selectedIndex={0}
      sections={sections}
      onKeyDown={() => undefined}
    />
  );
}

function renderPalette(isOpen: boolean) {
  return render(paletteElement(isOpen));
}

function renderHintedPalette() {
  return render(paletteElement(true, HINTED_SECTIONS));
}

/**
 * Every keyboard hint the palette renders: the ⌘K cap in the search row and
 * the per-item chord hints. Counted rather than probed for presence, so a
 * regression that drops one of the two still fails.
 */
function keyboardHints(): string[] {
  const dialog = screen.getByRole("dialog");
  const caps = Array.from(dialog.querySelectorAll("kbd")).map(
    (el) => el.textContent ?? "",
  );
  const itemHints = Array.from(dialog.querySelectorAll("span"))
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent ?? "")
    .filter((text) => text.startsWith("⌘"));
  return [...caps, ...itemHints];
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

  test("renders nothing while closed outside native mobile shells", () => {
    isMobileRef.value = true;
    nativeMobileRef.value = false;

    renderPalette(false);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("unmounts the sheet synchronously on close outside native mobile shells", () => {
    isMobileRef.value = true;
    nativeMobileRef.value = false;

    const { rerender } = renderPalette(true);
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();

    rerender(paletteElement(false));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("keeps the sheet in the DOM after close in native mobile shells", () => {
    isMobileRef.value = true;
    nativeMobileRef.value = true;

    const { rerender } = renderPalette(true);
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();

    rerender(paletteElement(false));

    // The load-bearing behavior: AnimatePresence holds the sheet in the DOM
    // while the exit plays, so the chat underneath stays covered.
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  });

  test("stops taking taps and announcing itself while the exit plays", () => {
    isMobileRef.value = true;
    nativeMobileRef.value = true;

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
    nativeMobileRef.value = true;

    const { rerender } = renderPalette(true);
    const input = screen.getByRole("textbox", { name: "Search" });
    input.focus();
    expect(document.activeElement).toBe(input);

    rerender(paletteElement(false));

    // Blurring starts keyboard dismissal alongside the slide-out.
    expect(document.activeElement).not.toBe(input);
  });

  test("leaves focus outside the sheet alone when the exit starts", () => {
    isMobileRef.value = true;
    nativeMobileRef.value = true;

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

  test("renders the mobile sheet affordances in native mobile shells", () => {
    isMobileRef.value = true;
    nativeMobileRef.value = true;

    renderPalette(true);

    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close search" })).toBeTruthy();
  });
});

/**
 * The container is the window-size question and the keyboard hints are the
 * input-capability one, so the cases that matter are the two where the axes
 * disagree: a roomy tablet, and a desktop window narrowed past the breakpoint.
 * See `docs/PLATFORM_ADAPTATION.md`.
 */
describe("CommandPalette keyboard hints", () => {
  const viewport = viewportAxesStub();

  afterEach(() => {
    viewport.restore();
  });

  test("shows the ⌘K cap and every chord hint under a mouse", () => {
    viewport.set({ narrow: false, coarsePointer: false });
    isMobileRef.value = false;

    renderHintedPalette();

    expect(keyboardHints()).toEqual(["⌘K", "⌘⇧O"]);
  });

  test("keeps the hints on a narrow window that still has a keyboard", () => {
    // A desktop browser window narrowed past 767px, an Electron window
    // resized, macOS tiling: compact, but every chord still fires.
    viewport.set({ narrow: true, coarsePointer: false });
    isMobileRef.value = true;

    renderHintedPalette();

    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    expect(keyboardHints()).toEqual(["⌘K", "⌘⇧O"]);
  });

  test("drops the hints on a roomy touch device that cannot press them", () => {
    // A tablet in either orientation, or a phone in landscape: no ⌘ on a soft
    // keyboard, so every hint here names a gesture the device cannot make.
    viewport.set({ narrow: false, coarsePointer: true });
    isMobileRef.value = false;

    renderHintedPalette();

    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeTruthy();
    expect(keyboardHints()).toEqual([]);
  });

  test("drops the hints on a phone", () => {
    viewport.set({ narrow: true, coarsePointer: true });
    isMobileRef.value = true;

    renderHintedPalette();

    expect(keyboardHints()).toEqual([]);
  });
});
