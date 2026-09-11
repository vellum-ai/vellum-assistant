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
