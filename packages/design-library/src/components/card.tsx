import { Slot } from "@radix-ui/react-slot";
import {
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";
import { Typography } from "./typography";

type CardPadding = "sm" | "md" | "lg";

/**
 * The card's resting fill. `lift` rises off the page and the other surfaces a
 * card usually sits on. `overlay` is for a card that sits on `--surface-lift`
 * itself, such as a side drawer's body, where a lift fill would be the drawer's
 * own color and the card would read only by its border.
 */
type CardSurface = "lift" | "overlay";

const SURFACE_CLASSES: Record<CardSurface, string> = {
  lift: "bg-[var(--surface-lift)]",
  overlay: "bg-[var(--surface-overlay)]",
};

const PADDING_CLASSES: Record<CardPadding, string> = {
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export interface CardRootProps extends ComponentProps<"div"> {
  padding?: CardPadding;
  /** The resting fill; see {@link CardSurface}. */
  surface?: CardSurface;
  bordered?: boolean;
  elevated?: boolean;
  noPadding?: boolean;
  clipContents?: boolean;
  asChild?: boolean;
  /**
   * Makes the whole card a click target: pointer cursor, hover and pressed
   * fills, and the library keyboard-focus ring. It adds no role, tab stop or
   * handler of its own, so pair it with `asChild` around a `<button>` or a
   * router `<Link>`, which bring the semantics and the keyboard behavior.
   */
  interactive?: boolean;
  /**
   * Draws the card as the chosen one of a set: primary border and a primary
   * tinted fill. Purely visual; the caller owns the matching ARIA state
   * (`aria-pressed`, `aria-current`, ...). For a selectable tile with its own
   * radio or checkbox semantics use `OptionCard`.
   */
  selected?: boolean;
  children?: ReactNode;
}

interface CardSectionProps extends ComponentProps<"div"> {
  padding?: CardPadding;
  children?: ReactNode;
}

const BASE_SURFACE_CLASSES = [
  "text-[color:var(--content-default)]",
  "rounded-xl",
].join(" ");

/**
 * The selected look shared by `Card` and `OptionCard`: primary border and a
 * 10% primary tint in place of the resting fill.
 */
const CARD_SELECTED_CLASSES = [
  "border-[var(--primary-base)]",
  "bg-[color-mix(in_srgb,var(--primary-base)_10%,transparent)]",
].join(" ");

/**
 * Click-target chrome for `interactive`. `block w-full text-left` keeps a
 * slotted `<button>` or `<a>` laid out like the `<div>` card it replaces.
 */
const CARD_INTERACTIVE_CLASSES = [
  "block w-full text-left cursor-pointer outline-none transition-colors",
  "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
  // A disabled slotted control takes no pointer at all, so it never reaches
  // the hover or pressed fill whatever fill the caller has given it.
  "disabled:pointer-events-none disabled:opacity-60",
  "aria-disabled:pointer-events-none aria-disabled:opacity-60",
].join(" ");

/** Hover and pressed fills; a selected card holds its tint instead. */
const CARD_INTERACTIVE_FILL_CLASSES = [
  "hover:bg-[var(--surface-base)]",
  "active:bg-[var(--surface-active)]",
].join(" ");

function rootClasses({
  padding,
  surface,
  bordered,
  elevated,
  hasSections,
  noPadding,
  clipContents,
  interactive,
  selected,
}: {
  padding: CardPadding;
  surface: CardSurface;
  bordered: boolean;
  elevated: boolean;
  hasSections: boolean;
  noPadding: boolean;
  clipContents: boolean;
  interactive: boolean;
  selected: boolean;
}): string {
  return cn(
    BASE_SURFACE_CLASSES,
    "border",
    selected
      ? CARD_SELECTED_CLASSES
      : [
          SURFACE_CLASSES[surface],
          bordered ? "border-[var(--border-subtle)]" : "border-transparent",
        ],
    interactive ? CARD_INTERACTIVE_CLASSES : null,
    interactive && !selected ? CARD_INTERACTIVE_FILL_CLASSES : null,
    elevated ? "shadow-sm" : null,
    clipContents ? "overflow-hidden" : null,
    !hasSections && !noPadding ? PADDING_CLASSES[padding] : null,
  );
}

function childrenContainSections(children: ReactNode): boolean {
  let found = false;
  const toCheck = Array.isArray(children) ? children : [children];
  for (const child of toCheck) {
    if (
      child != null &&
      typeof child === "object" &&
      "type" in child &&
      (child.type === CardHeader ||
        child.type === CardBody ||
        child.type === CardFooter)
    ) {
      found = true;
      break;
    }
  }
  return found;
}

function CardRoot({
  padding = "md",
  surface = "lift",
  bordered = true,
  elevated = false,
  noPadding = false,
  clipContents = false,
  asChild = false,
  interactive = false,
  selected = false,
  className,
  children,
  ref,
  ...rest
}: CardRootProps) {
  const Comp = asChild ? Slot : "div";
  const hasSections = childrenContainSections(children);
  return (
    <Comp
      {...rest}
      ref={ref}
      data-slot="card"
      data-selected={selected ? "" : undefined}
      className={cn(
        rootClasses({
          padding,
          surface,
          bordered,
          elevated,
          hasSections,
          noPadding,
          clipContents,
          interactive,
          selected,
        }),
        className,
      )}
    >
      {children}
    </Comp>
  );
}

function CardHeader({
  padding = "md",
  className,
  children,
  ref,
  ...rest
}: CardSectionProps) {
  return (
    <Typography
      {...rest}
      ref={ref as CardSectionProps["ref"]}
      variant="title-small"
      as="div"
      data-slot="card-header"
      className={cn(
        PADDING_CLASSES[padding],
        "border-b border-[var(--border-base)]",
        "text-[color:var(--content-default)]",
        className,
      )}
    >
      {children}
    </Typography>
  );
}

function CardBody({
  padding = "md",
  className,
  children,
  ref,
  ...rest
}: CardSectionProps) {
  return (
    <div
      {...rest}
      ref={ref}
      data-slot="card-body"
      className={cn(PADDING_CLASSES[padding], className)}
    >
      {children}
    </div>
  );
}

function CardFooter({
  padding = "md",
  className,
  children,
  ref,
  ...rest
}: CardSectionProps) {
  return (
    <div
      {...rest}
      ref={ref}
      data-slot="card-footer"
      className={cn(
        PADDING_CLASSES[padding],
        "border-t border-[var(--border-base)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function CardDefault({
  children,
  padding = "md",
  noPadding = false,
  ref,
  ...rest
}: CardRootProps) {
  return (
    <CardRoot ref={ref} padding={padding} noPadding={noPadding} {...rest}>
      {noPadding ? children : <CardBody padding={padding}>{children}</CardBody>}
    </CardRoot>
  );
}

type CardComponent = typeof CardDefault & {
  Root: typeof CardRoot;
  Header: typeof CardHeader;
  Body: typeof CardBody;
  Footer: typeof CardFooter;
};

const Card = CardDefault as CardComponent;
Card.Root = CardRoot;
Card.Header = CardHeader;
Card.Body = CardBody;
Card.Footer = CardFooter;

export {
  Card,
  CardRoot,
  CardHeader,
  CardBody,
  CardFooter,
  CARD_SELECTED_CLASSES,
};
