
import type { LucideIcon } from "lucide-react";
import { forwardRef, type ReactNode } from "react";

import { PanelItem } from "@vellum/design-library";

export interface CommandPaletteItemProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  shortcutHint?: ReactNode;
  isSelected: boolean;
  onClick: () => void;
}

/**
 * A single result row inside the CommandPalette. Built on the PanelItem
 * primitive for consistent hover/active treatment.
 */
export const CommandPaletteItem = forwardRef<
  HTMLButtonElement,
  CommandPaletteItemProps
>(function CommandPaletteItem(
  { icon, title, subtitle, shortcutHint, isSelected, onClick },
  ref,
) {
  return (
    <PanelItem
      ref={ref}
      icon={icon}
      label={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{title}</span>
          {subtitle ? (
            <span className="shrink-0 truncate text-[var(--content-tertiary)] text-body-small-default">
              {subtitle}
            </span>
          ) : null}
          {shortcutHint ? (
            <span className="ml-auto shrink-0 text-[var(--content-tertiary)] text-body-small-default">
              {shortcutHint}
            </span>
          ) : null}
        </span>
      }
      active={isSelected}
      onSelect={onClick}
      className="px-3 py-2"
    />
  );
});
