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
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
  });

  test("renders the mobile sheet affordances in the iOS shell", () => {
    isMobileRef.value = true;
    nativeIOSRef.value = true;

    renderPalette(true);

    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close search" })).toBeTruthy();
  });
});
