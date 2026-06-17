import { useEffect, useRef } from "react";

import { PanelItem } from "@vellumai/design-library";

import type { EmojiEntry } from "@/domains/chat/components/chat-composer/emoji-catalog";

interface EmojiPickerPopupProps {
  entries: EmojiEntry[];
  selectedIndex: number;
  onSelect: (entry: EmojiEntry) => void;
}

/**
 * Popup listbox for emoji shortcode completions. Mirrors the structural pattern
 * of SlashCommandPopup: rendered above the composer form when the user types
 * `:shortcode`.
 *
 * Uses `PanelItem asChild` for design-system-compliant hover / active surface
 * tokens — same pattern as `SlashCommandPopup`.
 */
export function EmojiPickerPopup({ entries, selectedIndex, onSelect }: EmojiPickerPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected row scrolled into view.
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const selected = container.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (entries.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      className="mb-1 max-h-[240px] overflow-y-auto overflow-x-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] py-1 shadow-[0_-4px_12px_rgba(0,0,0,0.3)]"
    >
      {entries.map((entry, i) => (
        <PanelItem key={entry.shortcode} asChild active={i === selectedIndex} label="">
          <button
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelect(entry)}
            className="flex h-auto w-full items-center gap-3 rounded-none px-4 py-2 text-left"
          >
            {/* typography: off-scale — emoji glyph sized to match row height, not a text style */}
            { }
            <span className="text-xl leading-none">{entry.emoji}</span>
            <span className="text-body-small-default text-[var(--content-secondary)]">
              :{entry.shortcode}:
            </span>
          </button>
        </PanelItem>
      ))}
    </div>
  );
}
