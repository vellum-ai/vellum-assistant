/**
 * The "…" control on a sidebar section header, opening that section's
 * actions.
 *
 * A 20px box matching the disclosure chevron beside it, growing to 30px on
 * touch. That scale belongs to the section header rather than to the design
 * library's `Button`, whose icon-only sizes are 32px and 24px; either would
 * overflow a 30px header row and sit taller than the chevron it pairs with.
 *
 * It renders as a bare `<button>` so Radix can drive it through `asChild`:
 * `Popover.Trigger` and `BottomSheet.Trigger` clone it and supply the ref,
 * `aria-expanded`, and `data-state` this forwards through. The click is
 * stopped from reaching the header, whose own click toggles the section.
 */

import { MoreHorizontal } from "lucide-react";
import type { ComponentProps, MouseEvent } from "react";

import { cn } from "@vellumai/design-library/utils/cn";

const BUTTON_CLASSES = [
  "flex h-5 w-5 items-center justify-center rounded-[4px]",
  "text-[var(--content-tertiary)] transition-colors",
  "hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)]",
  "aria-[expanded=true]:bg-[var(--surface-active)]",
  "aria-[expanded=true]:text-[var(--content-emphasised)]",
  "max-md:h-[30px] max-md:w-[30px]",
].join(" ");

export interface SectionActionsButtonProps
  extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
  /** Section name, which names the control for assistive tech. */
  label: string;
}

export function SectionActionsButton({
  label,
  className,
  onClick,
  ...rest
}: SectionActionsButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={`${label} actions`}
      aria-haspopup="menu"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      className={cn(BUTTON_CLASSES, className)}
    >
      <MoreHorizontal
        size={14}
        aria-hidden
        className="max-md:h-[21px] max-md:w-[21px]"
      />
    </button>
  );
}
