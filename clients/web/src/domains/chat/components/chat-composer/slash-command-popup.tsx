import { PanelItem } from "@vellumai/design-library";

import type { SlashCommand } from "@/domains/chat/components/chat-composer/slash-command-catalog";

// ---------------------------------------------------------------------------
// SlashCommandPopup — floating listbox rendered above the composer form
// ---------------------------------------------------------------------------

interface SlashCommandPopupProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashCommandPopup({ commands, selectedIndex, onSelect }: SlashCommandPopupProps) {
  if (commands.length === 0) return null;
  return (
    <div
      role="listbox"
      className="mb-1 overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] py-1 shadow-[0_-4px_12px_rgba(0,0,0,0.3)]"
    >
      {commands.map((cmd, i) => (
        <SlashCommandRow
          key={cmd.name}
          command={cmd}
          isSelected={i === selectedIndex}
          onSelect={() => onSelect(cmd)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlashCommandRow — individual option in the listbox
//
// Uses PanelItem with `asChild` to get the design system's hover / active
// surface tokens without applying them directly on a raw element.
// ---------------------------------------------------------------------------

interface SlashCommandRowProps {
  command: SlashCommand;
  isSelected: boolean;
  onSelect: () => void;
}

function SlashCommandRow({ command, isSelected, onSelect }: SlashCommandRowProps) {
  return (
    <PanelItem asChild active={isSelected} label="">
      <button
        role="option"
        aria-selected={isSelected}
        onClick={onSelect}
        className="flex h-auto w-full items-center gap-3 rounded-none px-3 py-2 text-left text-body-medium-lighter"
      >
        <span className="text-body-small-default font-mono text-[var(--primary-base)]">
          /{command.name}
        </span>
        <span className="text-[var(--content-secondary)]">{command.description}</span>
      </button>
    </PanelItem>
  );
}
