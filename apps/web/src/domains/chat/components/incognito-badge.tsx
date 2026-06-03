import { Typography } from "@vellum/design-library";
import { EyeOff } from "lucide-react";

import { cn } from "@/utils/misc";

/**
 * Weak-background / secondary-text pill marking the active conversation as
 * incognito. Mirrors {@link RiskBadge}'s structure and design-token usage so
 * the chat header right slot stays visually consistent.
 */
export function IncognitoBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="incognito-badge"
      className={cn(
        "inline-flex items-center justify-center gap-[4px] rounded-[100px] px-[6px] pt-[2px] pb-[3px]",
        "bg-[var(--surface-active)]",
        className,
      )}
    >
      <EyeOff className="h-3 w-3 shrink-0 text-[var(--content-secondary)]" />
      <Typography variant="label-medium-default" className="text-[var(--content-secondary)]">
        Incognito
      </Typography>
    </span>
  );
}
