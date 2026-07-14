import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const { CommandPalette } = await import(
  "@/components/command-palette/command-palette"
);

afterEach(() => {
  cleanup();
  isMobileRef.value = false;
});

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
        sections={[
          {
            id: "actions",
            label: "Actions",
            items: [{ id: "new", title: "New Conversation" }],
          },
        ]}
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

});