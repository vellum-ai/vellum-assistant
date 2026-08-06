/**
 * Row primitives for the `PanelItem`-based menu surfaces — the desktop
 * popover and the mobile bottom sheet — shared by the per-conversation menu
 * (`conversation-actions-menu.tsx`) and the section-header menu
 * (`group-actions-menu.tsx`).
 *
 * The Radix `Menu` / `ContextMenu` surfaces render their own item components
 * and don't go through these.
 */

import { type ReactNode } from "react";

import { type LucideIcon } from "lucide-react";

import { PanelItem } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

/** 1px divider matching the in-popover separator style used across the app. */
export function PanelMenuDivider() {
  return (
    <div aria-hidden="true" className="my-1 h-px bg-[var(--border-overlay)]" />
  );
}

export interface PanelMenuItemOptions {
  key: string;
  icon?: LucideIcon;
  label: string;
  disabled?: boolean;
  className?: string;
  run: () => void;
  /** Dismisses the surrounding popover or sheet. */
  onClose: () => void;
}

/**
 * Build a single menu row. `run` fires first, then the surface dismisses via
 * `onClose`, so the action's own UI feedback (dialogs, toasts, navigation)
 * doesn't appear underneath a still-open sheet.
 */
export function buildPanelMenuItem({
  key,
  icon,
  label,
  disabled,
  className,
  run,
  onClose,
}: PanelMenuItemOptions): ReactNode {
  return (
    <PanelItem
      key={key}
      icon={icon}
      label={label}
      // `disabled` keeps the row's `role="button"` and keyboard semantics and
      // blocks activation itself — dropping `onSelect` instead falls through
      // to PanelItem's non-interactive variant, leaving assistive technology
      // with plain text rather than a disabled action. It carries no visual
      // treatment, so the dimming is applied here to match the Radix menu
      // surfaces (`menuItemBase` in the design library).
      disabled={disabled}
      onSelect={() => {
        run();
        onClose();
      }}
      className={cn(
        disabled && "cursor-not-allowed text-[var(--content-disabled)]",
        className,
      )}
    />
  );
}
