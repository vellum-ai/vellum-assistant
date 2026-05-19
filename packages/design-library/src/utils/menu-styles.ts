/**
 * Shared styling constants used by `Menu` and `ContextMenu`. Both components
 * intentionally render identical item/content visuals so a context-menu and an
 * action-menu against the same target look the same.
 */

export const menuItemBase = [
  "relative flex cursor-pointer select-none items-center gap-2",
  "rounded-md px-2 py-1.5 text-body-medium-default outline-none",
  "text-[var(--content-secondary)]",
  "data-[highlighted]:bg-[var(--surface-hover)]",
  "data-[highlighted]:text-[var(--content-emphasised)]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:text-[var(--content-disabled)]",
  "data-[disabled]:data-[highlighted]:bg-transparent",
  "transition-colors",
].join(" ");

export const menuContentBase = [
  "z-50 min-w-[10rem] overflow-hidden rounded-lg bg-[var(--surface-lift)] p-2 shadow-[var(--shadow-popover)]",
  "data-[state=open]:animate-in data-[state=closed]:animate-out",
  "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
  "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
].join(" ");
