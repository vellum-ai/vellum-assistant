/**
 * A settings action that keeps its label where there is room for it and drops
 * to its icon where there is not.
 *
 * Collapsing is driven by the window's width rather than the pointer: what
 * runs out on a phone is horizontal space in a row, and a desktop window
 * dragged narrow runs out of exactly the same thing. The label survives as the
 * accessible name and the tooltip, so a collapsed button is never a bare glyph
 * to a screen reader. See `docs/PLATFORM_ADAPTATION.md`.
 *
 * Shared by the MCP page header and each server row, so the two clusters
 * cannot collapse at different widths or in different ways.
 */

import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { useIsMobile } from "@/hooks/use-is-mobile";

interface McpActionButtonProps {
  variant: "primary" | "outlined";
  /* Narrowed the way `Button.iconOnly` is: a bare boolean would put icon-only
     chrome on a button with no icon in it. */
  icon: Exclude<ReactNode, boolean>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function McpActionButton({
  variant,
  icon,
  label,
  onClick,
  disabled,
}: McpActionButtonProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Button
        variant={variant}
        iconOnly={icon}
        onClick={onClick}
        disabled={disabled}
        tooltip={label}
        aria-label={label}
      />
    );
  }

  return (
    <Button
      variant={variant}
      leftIcon={icon}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}
