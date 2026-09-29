import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import {
  Button,
  cn,
  type ButtonProps,
  type ButtonVariant,
} from "@vellumai/design-library";

export interface SidebarDiscButtonProps extends Omit<
  ButtonProps,
  | "variant"
  | "size"
  | "iconOnly"
  | "expandOnMobile"
  | "iconOnlyGlyphClassName"
  | "children"
> {
  icon: LucideIcon;
  /** Diameter, in px: the assistant row's disc size, or the rail's tile. */
  size: number;
  /**
   * `accent` (the default) wears the assistant's colour, as every control
   * that acts for her does. The onboarding tour passes `ghost` to drain it.
   */
  variant?: Extract<ButtonVariant, "accent" | "ghost">;
  /**
   * How the `accent` variant wears the colour. `filled` (the default) is the
   * solid disc; `wash` is the same colour at the pill's own strength (15% of
   * the accent into the lift, 24% raised) with the glyph in the accent, so
   * the control reads as part of the pill it sits beside rather than as an
   * action on it.
   */
  tone?: "filled" | "wash";
  /**
   * Drawn beside the glyph and positioned against the button (an activity
   * dot on its corner), since an icon-only `Button` renders nothing else.
   */
  badge?: ReactNode;
}

/**
 * An icon-only `Button` drawn as a circle at one of the sidebar's two disc
 * sizes: the controls that act for the assistant beside her pill and in the
 * collapsed rail's column (the section toggle, New Chat).
 *
 * The colour is the `Button` primitive's `accent` variant, which the app
 * maps onto the assistant's avatar accent; this owns the geometry and, for
 * the `wash` tone, restates the variant's fill and glyph at the pill's
 * strength through the same custom properties the app maps. The size is set
 * inline because it comes from a layout constant, and the primitive's own
 * mobile growth steps aside so that constant holds at every width. The glyph
 * is drawn at the size every other leading icon in the rail is.
 *
 * Transitional: the circle is a `rounded-full` class only because `Button`
 * has no shape option yet. Once it has `shape="pill"`, use that here and
 * drop the class.
 */
export function SidebarDiscButton({
  icon: Icon,
  size,
  variant = "accent",
  tone = "filled",
  badge,
  className,
  style,
  ...rest
}: SidebarDiscButtonProps) {
  const washed = variant === "accent" && tone === "wash";
  return (
    <Button
      {...rest}
      variant={variant}
      data-tone={washed ? "wash" : undefined}
      iconOnly={
        <>
          <Icon />
          {badge}
        </>
      }
      iconOnlyGlyphClassName="max-md:size-4 max-md:[&_svg]:size-4"
      expandOnMobile={false}
      className={cn(
        "shrink-0 rounded-full",
        /* The variant darkens its fill on hover and press, which on a wash
           reads as a grey; the raised wash is what the pill's rows do. */
        washed && [
          "hover:bg-[var(--sidebar-disc-wash-raised)]",
          "active:bg-[var(--sidebar-disc-wash-raised)]",
        ],
        className,
      )}
      style={{
        ...style,
        ...(washed ? WASH_STYLE : undefined),
        width: size,
        height: size,
      }}
    />
  );
}

/**
 * The pill's wash (`PANEL_ITEM_WASH`: 15% at rest, 24% raised) as the
 * `accent` variant's fill, from the accent the app publishes, with the
 * glyph in the accent itself. Falls back to the variant's own colours when
 * no accent is published (a custom-image avatar), the way the pill falls
 * back to the plain lift.
 */
const WASH_STYLE = {
  "--sidebar-disc-wash-raised":
    "color-mix(in srgb, var(--avatar-accent, var(--primary-base)) 24%, var(--surface-lift))",
  "--vbtn-accent":
    "color-mix(in srgb, var(--avatar-accent, var(--primary-base)) 15%, var(--surface-lift))",
  "--vbtn-accent-fg": "var(--avatar-accent, var(--primary-base))",
  "--vbtn-accent-glyph": "var(--avatar-accent, var(--primary-base))",
} as CSSProperties;
