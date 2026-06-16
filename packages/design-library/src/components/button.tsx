import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import {
  cloneElement,
  isValidElement,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../utils/cn";
import { Tooltip } from "./tooltip";

/**
 * Standardized button for the web platform. Visual parity with the macOS
 * design system button.
 * Semantic tokens resolve via CSS variables declared in `tokens.css`, so the
 * button inherits app light/dark theming automatically.
 *
 * - Pass `variant` for chrome style and `size` for dimensions.
 * - Pass `leftIcon` / `rightIcon` for text+icon layouts.
 * - Pass `iconOnly` to render a square icon-only button (the icon is centered
 *   at the correct size for the chosen `size`). Without `asChild` the children
 *   are ignored; with `asChild` the caller's element (e.g. a `Link`) becomes
 *   the root and the icon is re-parented into it.
 * - Use `asChild` to render as a child element (e.g. a `Link`) while keeping
 *   button styling and accessibility semantics. Uses Radix's `Slot`.
 * - Pass `expandOnMobile={false}` to opt an icon-only button out of the larger
 *   circular tap target on touch-mobile devices — useful for compact inline
 *   affordances like a chip's remove "×".
 * - Callers may always override styles via `className` / `style`.
 */
const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-1.5 cursor-pointer",
    "select-none whitespace-nowrap transition-[background-color,color,border-color,transform,box-shadow]",
    "duration-150 ease-out outline-none border",
    "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
    "active:scale-[0.97]",
    "disabled:cursor-not-allowed disabled:active:scale-100",
    "aria-disabled:cursor-not-allowed aria-disabled:pointer-events-none aria-disabled:opacity-60 aria-disabled:active:scale-100",
    "text-[color:var(--vbtn-fg)]",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "[--vbtn-fg:var(--content-inset)]",
          "bg-[var(--primary-base)]",
          "hover:bg-[var(--primary-hover)]",
          "active:bg-[var(--primary-active)]",
          "border-transparent",
          "disabled:bg-[var(--primary-disabled)]",
          "disabled:[--vbtn-fg:var(--content-disabled)]",
        ].join(" "),
        danger: [
          "[--vbtn-fg:var(--aux-white)]",
          "bg-[var(--system-negative-strong)]",
          "hover:bg-[var(--system-negative-hover)]",
          "active:bg-[var(--system-negative-hover)]",
          "border-transparent",
          "disabled:bg-[var(--primary-disabled)]",
          "disabled:[--vbtn-fg:var(--content-disabled)]",
        ].join(" "),
        dangerOutline: [
          "[--vbtn-fg:var(--system-negative-strong)]",
          "bg-transparent",
          "border-[var(--system-negative-strong)]",
          "hover:[--vbtn-fg:var(--system-negative-hover)]",
          "hover:border-[var(--system-negative-hover)]",
          "active:border-[var(--system-negative-hover)]",
          "disabled:border-[var(--primary-disabled)]",
          "disabled:[--vbtn-fg:var(--content-disabled)]",
        ].join(" "),
        dangerGhost: [
          "[--vbtn-fg:var(--system-negative-strong)]",
          "bg-transparent border-transparent",
          "hover:[--vbtn-fg:var(--system-negative-hover)]",
          "hover:bg-[var(--system-negative-weak)]",
          "active:bg-[var(--system-negative-weak)] active:scale-100",
          "disabled:[--vbtn-fg:var(--content-disabled)]",
        ].join(" "),
        outlined: [
          "[--vbtn-fg:var(--primary-base)]",
          "bg-transparent",
          "border-[var(--border-element)]",
          "hover:[--vbtn-fg:var(--primary-active)]",
          "hover:bg-[color-mix(in_srgb,var(--primary-second-hover)_15%,transparent)]",
          "active:bg-[color-mix(in_srgb,var(--primary-second-hover)_20%,transparent)]",
          "disabled:border-[var(--primary-disabled)]",
          "disabled:[--vbtn-fg:var(--content-disabled)]",
          "disabled:bg-transparent",
        ].join(" "),
        ghost: [
          "[--vbtn-fg:var(--content-default)]",
          "bg-transparent border-transparent",
          "hover:[--vbtn-fg:var(--primary-active)]",
          "hover:bg-[color-mix(in_srgb,var(--primary-second-hover)_15%,transparent)]",
          "active:bg-[color-mix(in_srgb,var(--primary-second-hover)_20%,transparent)] active:scale-100",
          "disabled:[--vbtn-fg:var(--content-disabled)]",
        ].join(" "),
      },
      size: {
        regular: "h-8 px-2.5 text-body-medium-default rounded-md",
        compact: "h-6 px-2 text-label-medium-default rounded-md",
      },
      iconOnly: {
        true: "p-0",
        false: "",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
      active: {
        true: "",
        false: "",
      },
      expandOnMobile: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      {
        iconOnly: true,
        size: "regular",
        class: "h-8 w-8",
      },
      {
        iconOnly: true,
        size: "compact",
        class: "h-6 w-6",
      },
      {
        iconOnly: true,
        size: "regular",
        expandOnMobile: true,
        class: "touch-mobile:h-10 touch-mobile:w-10",
      },
      {
        iconOnly: true,
        size: "compact",
        expandOnMobile: true,
        class: "touch-mobile:h-10 touch-mobile:w-10",
      },
      {
        variant: "ghost",
        active: true,
        class: [
          "bg-[var(--surface-lift)]",
          "hover:bg-[var(--surface-active)]",
          "active:bg-[var(--surface-active)]",
          "[--vbtn-fg:var(--primary-active)]",
          "disabled:bg-[var(--border-disabled)]",
        ].join(" "),
      },
      {
        variant: "outlined",
        active: true,
        class: [
          "border-[var(--primary-base)]",
          "bg-[var(--surface-lift)]",
          "hover:bg-[var(--surface-active)]",
          "active:bg-[var(--surface-active)]",
          "[--vbtn-fg:var(--primary-active)]",
        ].join(" "),
      },
      {
        variant: "outlined",
        iconOnly: true,
        class: [
          "hover:bg-[var(--surface-base)]",
          "active:bg-[var(--surface-active)]",
        ].join(" "),
      },
      {
        variant: "ghost",
        iconOnly: true,
        active: false,
        class: "[--vbtn-fg:var(--content-tertiary)] hover:[--vbtn-fg:var(--primary-active)]",
      },
      {
        variant: "outlined",
        iconOnly: true,
        active: false,
        class: "[--vbtn-fg:var(--content-tertiary)] hover:[--vbtn-fg:var(--primary-active)]",
      },
      {
        variant: "ghost",
        iconOnly: true,
        expandOnMobile: true,
        class: [
          "touch-mobile:bg-[var(--surface-lift)]",
          "touch-mobile:rounded-full",
          "touch-mobile:[--vbtn-fg:var(--content-default)]",
          "touch-mobile:hover:bg-[var(--surface-active)]",
          "touch-mobile:active:bg-[var(--surface-active)]",
        ].join(" "),
      },
    ],
    defaultVariants: {
      variant: "primary",
      size: "regular",
      iconOnly: false,
      fullWidth: false,
      active: false,
      expandOnMobile: true,
    },
  },
);

type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export type ButtonVariant = NonNullable<ButtonVariantProps["variant"]>;
export type ButtonSize = NonNullable<ButtonVariantProps["size"]>;

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  iconOnly?: ReactNode;
  fullWidth?: boolean;
  active?: boolean;
  /**
   * When `true` (default), icon-only buttons grow to a larger circular tap
   * target on touch-mobile devices (narrow viewport + coarse pointer). Set to
   * `false` to keep the desktop sizing — useful for compact inline affordances
   * (e.g. a chip's remove "×") where the enlarged circle is undesirable.
   */
  expandOnMobile?: boolean;
  tintColor?: string;
  tooltip?: string;
  /** Side the tooltip is placed on. Defaults to Radix's "top". */
  tooltipSide?: "top" | "right" | "bottom" | "left";
  asChild?: boolean;
  children?: ReactNode;
}

function iconPxForSize(size: ButtonSize): number {
  return size === "compact" ? 10 : 14;
}

export { buttonVariants };

export function Button({
  ref,
  variant = "primary",
  size = "regular",
  leftIcon,
  rightIcon,
  iconOnly,
  fullWidth = false,
  active = false,
  expandOnMobile = true,
  tintColor,
  tooltip,
  tooltipSide,
  asChild = false,
  className,
  style,
  type,
  children,
  title,
  disabled,
  onClick,
  ...rest
}: ButtonProps) {
  const isIconOnly = iconOnly != null && iconOnly !== false;
  const isDisabled = disabled === true;
  const isSlotDisabled = asChild && isDisabled;
  const iconPx = iconPxForSize(size);
  const iconStyle: CSSProperties = {
    width: iconPx,
    height: iconPx,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
  // Size the icon with an explicit dimension (`[&_svg]:size-3.5`) rather than
  // `size-full`. `size-full` makes the SVG fill whatever element it lands in,
  // which breaks when the `asChild`/Slot path (especially nested under a
  // tooltip Slot) collapses the icon span and the button box onto one element:
  // the SVG would then fill the 24px button box instead of the 14px icon box.
  // A fixed size keeps the icon at the intended dimension regardless of nesting.
  const iconOnlyClass = cn(
    "inline-flex items-center justify-center shrink-0 size-3.5 [&_svg]:size-3.5",
    expandOnMobile && "touch-mobile:size-4 touch-mobile:[&_svg]:size-4",
  );

  const Comp = asChild ? Slot : "button";
  const composedStyle: CSSProperties = {
    ...(tintColor && !isDisabled
      ? { ["--vbtn-fg" as string]: tintColor }
      : null),
    ...style,
  };

  const handleBlockedClick = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const buttonElement = (
    <Comp
      {...rest}
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      disabled={asChild ? undefined : disabled}
      aria-disabled={isSlotDisabled ? true : rest["aria-disabled"]}
      data-disabled={isSlotDisabled ? "" : undefined}
      data-slot="button"
      tabIndex={isSlotDisabled ? -1 : rest.tabIndex}
      onClick={isSlotDisabled ? handleBlockedClick : onClick}
      title={title}
      className={cn(
        buttonVariants({ variant, size, iconOnly: isIconOnly, fullWidth, active, expandOnMobile }),
        className,
      )}
      style={composedStyle}
    >
      {isIconOnly ? (
        asChild && isValidElement(children) ? (
          // `asChild` + `iconOnly`: Slot merges the button props onto the
          // caller's element (e.g. an `<a>`), so inject the icon as that
          // element's child to keep the icon-only chrome while the link owns
          // navigation semantics (href, modified-click open-in-new-tab).
          cloneElement(
            children,
            undefined,
            <span aria-hidden="true" className={iconOnlyClass}>
              {iconOnly}
            </span>,
          )
        ) : (
          <span aria-hidden="true" className={iconOnlyClass}>
            {iconOnly}
          </span>
        )
      ) : leftIcon == null && rightIcon == null ? (
        children
      ) : (
        // When `asChild` is set, `Comp` is Radix's `Slot`, which forwards its
        // props (e.g. `type`, `disabled`) onto its single React-element child.
        // A bare Fragment can't accept those props — React 19 hard-errors with
        // "Invalid prop `type` supplied to React.Fragment". `Slottable` marks
        // `children` as the prop target so Slot clones the caller's element
        // and re-parents the icons as its children. In the non-asChild path
        // (`Comp === "button"`) Slottable is a transparent Fragment, so this
        // is safe for both branches.
        <>
          {leftIcon != null ? (
            <span aria-hidden="true" style={iconStyle}>
              {leftIcon}
            </span>
          ) : null}
          <Slottable>{children}</Slottable>
          {rightIcon != null ? (
            <span aria-hidden="true" style={iconStyle}>
              {rightIcon}
            </span>
          ) : null}
        </>
      )}
    </Comp>
  );

  if (tooltip) {
    return (
      <Tooltip content={tooltip} side={tooltipSide}>
        {buttonElement}
      </Tooltip>
    );
  }

  return buttonElement;
}
