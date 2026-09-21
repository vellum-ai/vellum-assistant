import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import {
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";
import { tagIconStyle, tagVariants, type TagTone } from "./tag";

/**
 * The interactive sibling of `Tag`: the same 24px geometry, tones and type,
 * rendered as a real `<button type="button">`. Reach for it wherever a tag
 * has to be clicked, instead of wrapping a `Tag` in a bare
 * `<button>` (which loses the focus ring and the hover and disabled states)
 * or hand-rolling a pill.
 *
 * - `tone`, `leftIcon` and `rightIcon` behave exactly as they do on `Tag`.
 * - A chip is an action, or with `asChild` a link or a Popover or Menu
 *   trigger. It is not a toggle: it has no `selected` state and emits no
 *   `aria-pressed`. A toggle or filter pill is `FilterChip`.
 * - Use `asChild` to render as the child element while keeping the chip
 *   chrome. Uses Radix's `Slot`.
 * - There is deliberately no `onRemove`. A remove button inside a button is
 *   invalid nesting, so a dismissible chip stays a `Tag` with `onRemove`.
 *
 * The chrome is `tagVariants` plus the classes below. Hover and press lay a
 * translucent wash of the label colour over the tone's own fill (a
 * background-image layer fed by `--chip-wash`), so one rule darkens every tone
 * in light themes and lightens it in dark ones without restating a fill per
 * tone, and the 24px box is untouched.
 */
const chipVariants = cva(
  [
    "cursor-pointer outline-none",
    "transition-[color,box-shadow] duration-150 ease-out",
    "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
    "[--chip-wash:transparent]",
    "bg-[image:linear-gradient(var(--chip-wash),var(--chip-wash))]",
    "not-disabled:hover:[--chip-wash:color-mix(in_srgb,currentColor_8%,transparent)]",
    "not-disabled:active:[--chip-wash:color-mix(in_srgb,currentColor_14%,transparent)]",
    "disabled:cursor-not-allowed disabled:opacity-60",
    "aria-disabled:cursor-not-allowed aria-disabled:pointer-events-none aria-disabled:opacity-60",
  ].join(" "),
);

export interface ChipProps extends Omit<ComponentProps<"button">, "children"> {
  tone?: TagTone;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /**
   * Render as the child element (e.g. a link or a Popover trigger) while
   * keeping the chip chrome. When combined with `leftIcon` / `rightIcon`,
   * `children` must be a single React element: Radix's Slot re-parents the
   * icons into it and throws (`Children.only`) on multi-node children.
   */
  asChild?: boolean;
  children?: ReactNode;
}

export function Chip({
  tone = "neutral",
  leftIcon,
  rightIcon,
  asChild = false,
  className,
  type,
  disabled,
  onClick,
  children,
  ref,
  ...rest
}: ChipProps) {
  // A slotted element (an `<a>`) has no native `disabled`, so it is blocked
  // the way Button blocks one: `aria-disabled`, out of the tab order, and a
  // swallowed click.
  const isSlotDisabled = asChild && disabled === true;
  const Comp = asChild ? Slot : "button";

  const handleBlockedClick = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Comp
      {...rest}
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      disabled={asChild ? undefined : disabled}
      aria-disabled={isSlotDisabled ? true : rest["aria-disabled"]}
      data-disabled={isSlotDisabled ? "" : undefined}
      data-slot="chip"
      tabIndex={isSlotDisabled ? -1 : rest.tabIndex}
      onClick={isSlotDisabled ? handleBlockedClick : onClick}
      className={cn(tagVariants({ tone }), chipVariants(), className)}
    >
      {asChild && leftIcon == null && rightIcon == null
        ? children
        : // A keyed array, not a Fragment: with `asChild`, Radix's `Slot`
          // looks for the `Slottable` among its DIRECT children to know which
          // element receives the chip props, and `Children.toArray` does not
          // descend into Fragments. A Fragment here would hide the Slottable,
          // and Slot would clone the Fragment instead, leaving the caller's
          // element unstyled. See the same note in `Button`.
          [
            leftIcon != null ? (
              <span key="left-icon" aria-hidden="true" style={tagIconStyle(tone)}>
                {leftIcon}
              </span>
            ) : null,
            asChild ? (
              <Slottable key="label">{children}</Slottable>
            ) : (
              // The label carries its own truncation, for the reason `Tag`
              // gives: the root is `inline-flex` and `whitespace-nowrap`, so a
              // bare text node could not ellipsize. A slotted child owns its
              // own content, so it gets no wrapper.
              <span key="label" data-slot="chip-label" className="min-w-0 truncate">
                {children}
              </span>
            ),
            rightIcon != null ? (
              <span key="right-icon" aria-hidden="true" style={tagIconStyle()}>
                {rightIcon}
              </span>
            ) : null,
          ]}
    </Comp>
  );
}

export { chipVariants };
