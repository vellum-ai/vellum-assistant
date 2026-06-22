
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PanelItem } from "@vellumai/design-library";

export interface CommandPaletteItemProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  shortcutHint?: ReactNode;
  isSelected: boolean;
  onClick: () => void;
  surface?: "overlay" | "window";
}

/**
 * A single result row inside the CommandPalette.
 */
export function CommandPaletteItem({
  icon,
  title,
  subtitle,
  shortcutHint,
  isSelected,
  onClick,
  surface = "overlay",
}: CommandPaletteItemProps) {
  const Icon = icon;

  if (surface === "window") {
    return (
      <button
        type="button"
        role="option"
        aria-current={isSelected ? "page" : undefined}
        aria-selected={isSelected}
        onClick={onClick}
        className={[
          "flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium outline-none transition-colors",
          isSelected
            ? "bg-[var(--surface-active)] text-[var(--content-default)]"
            : "text-[var(--content-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--content-default)]",
        ].join(" ")}
      >
        {Icon ? (
          <Icon
            size={16}
            aria-hidden
            className={
              isSelected
                ? "shrink-0 text-[var(--content-default)]"
                : "shrink-0 text-[var(--content-tertiary)]"
            }
          />
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{title}</span>
          {subtitle ? (
            <span className="shrink-0 truncate text-xs text-[var(--content-tertiary)]">
              {subtitle}
            </span>
          ) : null}
          {shortcutHint ? (
            <span className="ml-auto shrink-0 text-xs text-[var(--content-tertiary)]">
              {shortcutHint}
            </span>
          ) : null}
        </span>
      </button>
    );
  }

  return (
    <PanelItem
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
}
