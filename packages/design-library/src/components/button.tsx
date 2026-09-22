import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
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
 * - Pass `variant` for chrome style, `size` for dimensions (`compact` 24px,
 *   `regular` 32px, `large` 44px), and `shape="pill"` for fully rounded ends.
 * - `variant="accent"` is a filled button in a colour the consumer supplies
 *   through custom properties, the way `PanelItem` takes its tint, so the
 *   library stays unaware of where the colour comes from:
 *   - `--vbtn-accent`: the fill.
 *   - `--vbtn-accent-fg`: the ink for a label on that fill.
 *   - `--vbtn-accent-glyph`: the ink for an icon-only button's glyph, which
 *     needs no small-text contrast floor; falls back to `--vbtn-accent-fg`.
 *   Undeclared, it is the `primary` button. Hover and press deepen the fill
 *   a step, and disabled takes `primary`'s disabled fill.
 * - Pass `loading` while the action the button started is in flight. The
 *   spinner takes the leading icon's place (or the icon-only glyph's), the
 *   button announces `aria-busy`, and activation is blocked without dropping
 *   focus. Do not hand-roll a `Loader2` into `leftIcon`.
 * - Pass `leftIcon` / `rightIcon` for text+icon layouts.
 * - Pass the icon element as `iconOnly` (e.g. `iconOnly={<X />}`) to render a
 *   square icon-only button (the icon is centered at the correct size for the
 *   chosen `size`). Without `asChild` the children are ignored; with `asChild`
 *   the caller's element (e.g. a `Link`) becomes the root and the icon is
 *   re-parented into it.
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
        accent: [
          "[--vbtn-fg:var(--vbtn-accent-fg,var(--content-inset))]",
          "bg-[var(--vbtn-accent,var(--primary-base))]",
          "hover:bg-[color-mix(in_srgb,#000_10%,var(--vbtn-accent,var(--primary-hover)))]",
          "active:bg-[color-mix(in_srgb,#000_16%,var(--vbtn-accent,var(--primary-active)))]",
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
        link: [
          // The same look as `TextLink`, so an action that reads as a link
          // and a link that navigates cannot be told apart by their ink:
          // underlined at rest, never only on hover.
          "[--vbtn-fg:var(--content-link)]",
          "inline bg-transparent border-transparent",
          "underline hover:[--vbtn-fg:var(--content-link-hover)]",
          "active:scale-100",
          "disabled:[--vbtn-fg:var(--content-disabled)]",
        ].join(" "),
      },
      size: {
        regular: "h-8 px-2.5 text-body-medium-default rounded-md",
        compact: "h-6 px-2 text-body-small-default rounded-[6px]",
        large: "h-11 px-4 text-body-large-default rounded-md",
      },
      shape: {
        default: "",
        pill: "rounded-full",
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
        size: "large",
        class: "h-11 w-11",
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
        // A primary button that stands for something currently open or
        // selected holds its own pressed tone instead of springing back to
        // the resting fill, which is the same move `ghost` and `outlined`
        // make one step further out.
        variant: "primary",
        active: true,
        class: [
          "bg-[var(--primary-active)]",
          "hover:bg-[var(--primary-active)]",
          "active:bg-[var(--primary-active)]",
        ].join(" "),
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
      {
        variant: "accent",
        iconOnly: true,
        class:
          "[--vbtn-fg:var(--vbtn-accent-glyph,var(--vbtn-accent-fg,var(--content-inset)))]",
      },
      {
        variant: "link",
        class: "h-auto p-0 rounded-none text-[length:inherit] leading-[inherit]",
      },
    ],
    defaultVariants: {
      variant: "primary",
      size: "regular",
      shape: "default",
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
export type ButtonShape = NonNullable<ButtonVariantProps["shape"]>;

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** `pill` rounds the ends fully. The size's own radius applies otherwise. */
  shape?: ButtonShape;
  /**
   * The action this button started is in flight. A spinner replaces
   * `leftIcon` (or the `iconOnly` glyph; with neither, it takes the leading
   * slot), the button sets `aria-busy`, and clicks are ignored. The button is
   * marked `aria-disabled` rather than `disabled`, so keyboard focus stays
   * where the user left it and the label is still announced. Pass `disabled`
   * as well to keep the greyed disabled look while the work runs.
   */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /**
   * The icon element itself, not a flag. `true` is excluded from the type
   * because a bare `iconOnly` attribute would put the icon-only chrome on a
   * button with no visible content (`leftIcon`/`rightIcon`/`children` are
   * ignored in icon-only mode). `false` stays allowed for `cond && <Icon />`.
   */
  iconOnly?: Exclude<ReactNode, boolean> | false;
  fullWidth?: boolean;
  /**
   * Paints the button as the thing currently open or selected: `primary`,
   * `ghost`, and `outlined` each hold their own pressed tone rather than
   * springing back on mouse-out. Pair it with `aria-pressed` so the state is
   * announced and not only drawn.
   */
  active?: boolean;
  /**
   * When `true` (default), icon-only buttons grow to a larger circular tap
   * target on touch-mobile devices (narrow viewport + coarse pointer). Set to
   * `false` to keep the desktop sizing — useful for compact inline affordances
   * (e.g. a chip's remove "×") where the enlarged circle is undesirable.
   */
  expandOnMobile?: boolean;
  /**
   * Extra classes merged onto the icon-only glyph wrapper span (the element
   * that carries the `[&_svg]:size-3.5` sizing). This is the supported way to
   * resize an icon-only glyph: a call-site `className` lands on the button box,
   * where an `[&_svg]:size-*` utility only ties with the wrapper's own svg rule
   * and loses on source order. Because this string is merged onto the wrapper
   * itself (last in `cn`), an `[&_svg]:size-5` here reliably wins. Ignored
   * unless `iconOnly` is set.
   */
  iconOnlyGlyphClassName?: string;
  tintColor?: string;
  tooltip?: string;
  /** Side the tooltip is placed on. Defaults to Radix's "top". */
  tooltipSide?: "top" | "right" | "bottom" | "left";
  /**
   * Render as the child element (e.g. a `Link`) while keeping button
   * styling and accessibility semantics. When combined with `leftIcon` /
   * `rightIcon`, `children` must be a single React element: Radix's Slot
   * re-parents the icons into it and throws (`Children.only`) on
   * multi-node children.
   */
  asChild?: boolean;
  children?: ReactNode;
}

function iconPxForSize(size: ButtonSize): number {
  if (size === "compact") {
    return 10;
  }
  return size === "large" ? 16 : 14;
}

export { buttonVariants };

export function Button({
  ref,
  variant = "primary",
  size = "regular",
  shape = "default",
  loading = false,
  leftIcon: leftIconProp,
  rightIcon,
  iconOnly,
  fullWidth = false,
  active = false,
  expandOnMobile = true,
  iconOnlyGlyphClassName,
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
  // A loading button stays focusable, so it is blocked the way a disabled
  // slot is (aria-disabled plus a swallowed click) instead of with the native
  // attribute, which would drop focus to the body mid-action.
  // A natively disabled button is already inert and already has its look, so
  // loading adds nothing to it but the spinner and `aria-busy`.
  const isBlocked = isSlotDisabled || (loading && !isDisabled);
  const spinner = loading ? <Loader2 className="animate-spin" /> : null;
  const leftIcon = spinner ?? leftIconProp;
  const iconOnlyGlyph = spinner ?? iconOnly;
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
    "inline-flex items-center justify-center shrink-0",
    size === "large" ? "size-4 [&_svg]:size-4" : "size-3.5 [&_svg]:size-3.5",
    expandOnMobile && "touch-mobile:size-4 touch-mobile:[&_svg]:size-4",
    // Merged last so a caller-supplied `[&_svg]:size-*` overrides the defaults
    // above on the same element (source-order win), rather than fighting them
    // from the button box via a lower-priority descendant selector.
    iconOnlyGlyphClassName,
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
      aria-disabled={isBlocked ? true : rest["aria-disabled"]}
      aria-busy={loading ? true : rest["aria-busy"]}
      data-disabled={isSlotDisabled ? "" : undefined}
      data-loading={loading ? "" : undefined}
      data-slot="button"
      data-variant={variant}
      tabIndex={isSlotDisabled ? -1 : rest.tabIndex}
      onClick={isBlocked ? handleBlockedClick : onClick}
      title={title}
      className={cn(
        buttonVariants({ variant, size, shape, iconOnly: isIconOnly, fullWidth, active, expandOnMobile }),
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
              {iconOnlyGlyph}
            </span>,
          )
        ) : (
          <span aria-hidden="true" className={iconOnlyClass}>
            {iconOnlyGlyph}
          </span>
        )
      ) : leftIcon == null && rightIcon == null ? (
        children
      ) : (
        // When `asChild` is set, `Comp` is Radix's `Slot`, which looks for a
        // `Slottable` among its DIRECT children (`Children.toArray(...).find`)
        // to know which element receives the button props, then re-parents
        // the sibling icons into that element. `Children.toArray` does not
        // descend into Fragments, so these must be a keyed array: a `<>...</>`
        // wrapper hides the Slottable and Slot falls back to cloning the
        // Fragment itself, silently dropping className/style/type on it and
        // leaving the caller's element unstyled. In the non-asChild path
        // (`Comp === "button"`) Slottable renders as a transparent Fragment,
        // so the array is safe for both branches.
        [
          leftIcon != null ? (
            <span key="left-icon" aria-hidden="true" style={iconStyle}>
              {leftIcon}
            </span>
          ) : null,
          <Slottable key="children">{children}</Slottable>,
          rightIcon != null ? (
            <span key="right-icon" aria-hidden="true" style={iconStyle}>
              {rightIcon}
            </span>
          ) : null,
        ]
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
