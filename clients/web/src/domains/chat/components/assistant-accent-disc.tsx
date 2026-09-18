import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

import {
  GroupIndicatorDot,
  type GroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { toneForBg } from "@/utils/avatar-tone";
import { cn } from "@vellumai/design-library";

export interface AssistantAccentDiscProps extends ComponentProps<"button"> {
  icon: LucideIcon;
  /** The avatar's colour, or null for the plain raised surface. */
  accentHex: string | null;
  /** Diameter, in px. */
  size: number;
  /** Names the disc in the DOM whatever trigger composes onto it. */
  slot: string;
  /** Activity to dot on the disc's corner, if any. */
  indicator?: GroupIndicatorState;
}

/**
 * A round button painted solid in the assistant's colour, with its glyph in
 * the avatar surfaces' contrast ink (black on the light colour, white on
 * every other). The controls that act for the assistant (the section
 * toggle, New Chat) are drawn with it, so they read as one family beside
 * the washed pill that names her. Without a colour to wear (an uploaded
 * image, a still-loading avatar, or the tour's drained nav) it falls back to
 * the plain raised surface every untinted row does.
 *
 * The glyph is drawn at the size every other leading icon in the rail is.
 * Every other prop reaches the button, so a popover or tooltip trigger can
 * compose its handlers and ref onto it.
 */
export function AssistantAccentDisc({
  icon: Icon,
  accentHex,
  size,
  slot,
  indicator = null,
  className,
  ...rest
}: AssistantAccentDiscProps) {
  return (
    <button
      type="button"
      {...rest}
      /* After the spread: a composing trigger clones its own slot name onto
         the button, and the disc keeps its own. */
      data-slot={slot}
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-full",
        "transition-[filter,transform] duration-150 active:scale-[0.98]",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        accentHex
          ? "[@media(hover:hover)]:hover:brightness-105"
          : "bg-[var(--surface-active)] text-[var(--content-default)] [@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
        className,
      )}
      style={{
        width: size,
        height: size,
        ...(accentHex
          ? { backgroundColor: accentHex, color: toneForBg(accentHex).fg }
          : undefined),
      }}
    >
      <Icon aria-hidden className="size-3.5 max-md:size-4" />
      <GroupIndicatorDot
        state={indicator}
        /* Ringed in the page ground so it reads as sitting on the disc's
           edge rather than as a bite out of it. */
        className="absolute -top-px -right-px ring-2 ring-[var(--surface-base)]"
      />
    </button>
  );
}
