import { ChevronDown } from "lucide-react";
import { Children, type ReactNode } from "react";

import { cn } from "../utils/cn";

import { ActionMenu } from "./action-menu";
import { Button, type ButtonProps } from "./button";

export interface SplitButtonProps
  extends Omit<ButtonProps, "rightIcon" | "asChild"> {
  /**
   * Draws the main half as a square icon button, for a surface with no room
   * for a verb (a tile's corner, a dense toolbar). It needs an `aria-label`,
   * since the half then carries no text of its own. Inherited from
   * {@link ButtonProps}, so it takes the icon element rather than a flag.
   */
  iconOnly?: ButtonProps["iconOnly"];
  /** The menu's accessible name, e.g. "Other ways to connect". */
  menuTitle: string;
  /** Accessible name for the chevron half, which draws no label of its own. */
  menuTriggerLabel: string;
  /** `ActionMenu.Item`s. Absent or empty renders a plain button. */
  menuItems?: ReactNode;
  /** Anchored alignment of the menu against the chevron. Sheets ignore it. */
  menuAlign?: "start" | "end";
  /**
   * The chevron's own disabled state. Defaults to `disabled`, so the pair
   * moves together. Set it `false` where the alternatives are a way out of
   * whatever is blocking the main action, e.g. a form the user has not
   * finished: locking the menu there leaves them nowhere to go.
   */
  menuDisabled?: boolean;
  /**
   * Classes for the button itself. They land on *both* halves, so a height or
   * a touch target applies to the pair; a width belongs here only when both
   * halves are square, which is the `iconOnly` case.
   */
  className?: string;
}

/**
 * One obvious action with the rest of them a chevron away.
 *
 * A split button is the shape to reach for when a surface has several ways to
 * do the same thing and one of them is right almost every time: the
 * recommended path stays a single click, and the alternatives stop competing
 * with it for the eye. A row of equal buttons asks the user to choose before
 * they know enough to choose.
 *
 * ```tsx
 * <SplitButton
 *   menuTitle="Other ways to connect"
 *   menuTriggerLabel="Other ways to connect Notion"
 *   menuItems={[
 *     <ActionMenu.Item key="vellum" label="Sign in through Vellum" onSelect={pickVellum} />,
 *   ]}
 *   onClick={connect}
 * >
 *   Connect
 * </SplitButton>
 * ```
 *
 * The menu is an {@link ActionMenu}, so the alternatives arrive as a bottom
 * sheet under a thumb and an anchored dropdown under a pointer without the
 * caller checking. With no items the chevron is not drawn at all, because a
 * menu that opens on nothing is worse than no menu. The `split-button` root
 * stays either way, so a consumer's CSS hook does not come and go with the
 * length of the menu.
 *
 * Both halves share `variant`, `size`, and `expandOnMobile`, because a split
 * button whose halves disagree reads as two controls that happen to touch.
 * `expandOnMobile` defaults to `false` for that reason: the touch-mobile
 * circle it grows an icon button into would apply to an icon-only main half
 * and not to the chevron, splitting the pair in two. A surface that needs a
 * bigger target on touch sizes both halves through `className`. `fullWidth`
 * stretches the pair rather than the main half, leaving the chevron at its
 * square icon width.
 *
 * @see https://spectrum.adobe.com/page/split-button/
 */
export function SplitButton({
  menuTitle,
  menuTriggerLabel,
  menuItems,
  menuAlign = "end",
  menuDisabled,
  variant = "primary",
  size = "regular",
  disabled,
  fullWidth = false,
  expandOnMobile = false,
  className,
  children,
  ...rest
}: SplitButtonProps) {
  // `Children.toArray` drops `null`, `undefined`, and booleans, so a caller
  // that maps over an empty list or guards each item with `cond && <Item />`
  // lands on the plain-button branch rather than drawing a dead chevron.
  const hasMenu = Children.toArray(menuItems).length > 0;

  // The root is the component's styling hook, so it is the same element
  // whether or not there are alternatives. `Button` writes its own
  // `data-slot`, so the two cannot share one.
  const main = (
    <Button
      {...rest}
      variant={variant}
      size={size}
      disabled={disabled}
      fullWidth={fullWidth}
      expandOnMobile={expandOnMobile}
      className={cn(className, hasMenu && "rounded-r-none")}
    >
      {children}
    </Button>
  );

  return (
    <span
      data-slot="split-button"
      className={cn("inline-flex items-stretch", fullWidth && "w-full")}
    >
      {main}
      {hasMenu ? (
        <ActionMenu.Root>
          <ActionMenu.Trigger asChild>
            <Button
              variant={variant}
              size={size}
              disabled={menuDisabled ?? disabled}
              aria-label={menuTriggerLabel}
              iconOnly={<ChevronDown />}
              expandOnMobile={expandOnMobile}
              // The seam is what says there are two targets here rather than
              // one wide button. It is mixed from the half's own foreground,
              // so it reads on a filled variant and on an outlined one
              // without a second colour to keep in step.
              className={cn(
                className,
                "-ml-px shrink-0 rounded-l-none",
                "border-l-[color:color-mix(in_srgb,var(--vbtn-fg)_35%,transparent)]",
              )}
            />
          </ActionMenu.Trigger>
          <ActionMenu.Content title={menuTitle} align={menuAlign}>
            {menuItems}
          </ActionMenu.Content>
        </ActionMenu.Root>
      ) : null}
    </span>
  );
}
