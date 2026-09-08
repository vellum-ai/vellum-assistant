import { Slot } from "@radix-ui/react-slot";
import {
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../utils/cn";

export type TypographyVariant =
  | "title-large"
  | "title-medium"
  | "title-small"
  | "body-large-lighter"
  | "body-large-default"
  | "body-medium-lighter"
  | "body-medium-default"
  | "body-small-lighter"
  | "body-small-default"
  | "body-small-emphasised"
  | "label-medium-default"
  | "label-small-default"
  | "chat";

const VARIANT_CLASS: Record<TypographyVariant, string> = {
  "title-large": "text-title-large",
  "title-medium": "text-title-medium",
  "title-small": "text-title-small",
  "body-large-lighter": "text-body-large-lighter",
  "body-large-default": "text-body-large-default",
  "body-medium-lighter": "text-body-medium-lighter",
  "body-medium-default": "text-body-medium-default",
  "body-small-lighter": "text-body-small-lighter",
  "body-small-default": "text-body-small-default",
  "body-small-emphasised": "text-body-small-emphasised",
  "label-medium-default": "text-label-medium-default",
  "label-small-default": "text-label-small-default",
  chat: "text-chat",
};

export type TypographyAs =
  | "span"
  | "p"
  | "div"
  | "label"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6";

export interface TypographyProps extends HTMLAttributes<HTMLElement> {
  variant: TypographyVariant;
  as?: TypographyAs;
  className?: string;
  children?: ReactNode;
  htmlFor?: string;
  ref?: Ref<HTMLElement>;
  /**
   * Render the single child element instead of `as`, merging the variant
   * class onto it. For elements outside `TypographyAs`, such as `<th>`,
   * `<td>`, `<a href>` or `<button type>`, whose own props cannot be added
   * to `HTMLAttributes<HTMLElement>` one at a time. Uses Radix's `Slot`,
   * matching `Button` and `Card`.
   *
   * `children` must be a single React element: Slot calls `Children.only`
   * and throws on multiple children, and a plain string renders nothing.
   *
   * Slot gives the child precedence on ordinary props, so a child that sets
   * its own `data-slot` keeps it and this component's marker does not apply.
   * The variant class still merges either way, so styling is unaffected and
   * only a `[data-slot="typography"]` selector stops matching.
   */
  asChild?: boolean;
}

export function Typography({
  variant,
  as = "span",
  className,
  children,
  ref,
  asChild = false,
  ...rest
}: TypographyProps) {
  const Comp: ElementType = asChild ? Slot : as;
  return (
    <Comp
      {...rest}
      ref={ref}
      data-slot="typography"
      className={cn(VARIANT_CLASS[variant], className)}
    >
      {children}
    </Comp>
  );
}
