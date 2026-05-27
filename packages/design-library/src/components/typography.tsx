import {
  createElement,
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
}

export function Typography({
  variant,
  as = "span",
  className,
  children,
  ref,
  ...rest
}: TypographyProps) {
  return createElement(
    as,
    {
      ...rest,
      ref,
      "data-slot": "typography",
      className: cn(VARIANT_CLASS[variant], className),
    },
    children,
  );
}
