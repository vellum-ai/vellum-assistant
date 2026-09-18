import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Button,
  cn,
  type ButtonProps,
  type ButtonVariant,
} from "@vellumai/design-library";

export interface SidebarDiscButtonProps
  extends Omit<
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
 * maps onto the assistant's avatar accent; this owns only the geometry. The
 * size is set inline because it comes from a layout constant, and the
 * primitive's own mobile growth steps aside so that constant holds at every
 * width. The glyph is drawn at the size every other leading icon in the
 * rail is.
 *
 * Transitional: the circle is a `rounded-full` class only because `Button`
 * has no shape option yet. Once it has `shape="pill"`, use that here and
 * drop the class.
 */
export function SidebarDiscButton({
  icon: Icon,
  size,
  variant = "accent",
  badge,
  className,
  style,
  ...rest
}: SidebarDiscButtonProps) {
  return (
    <Button
      {...rest}
      variant={variant}
      iconOnly={
        <>
          <Icon />
          {badge}
        </>
      }
      iconOnlyGlyphClassName="max-md:size-4 max-md:[&_svg]:size-4"
      expandOnMobile={false}
      className={cn("shrink-0 rounded-full", className)}
      style={{ ...style, width: size, height: size }}
    />
  );
}
