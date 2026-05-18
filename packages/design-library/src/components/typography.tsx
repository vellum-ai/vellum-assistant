import {
  createElement,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn.js";

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
}

export const Typography = forwardRef<HTMLElement, TypographyProps>(
  function Typography(
    { variant, as = "span", className, children, ...rest },
    ref,
  ) {
    return createElement(
      as,
      {
        ...rest,
        ref,
        className: cn(VARIANT_CLASS[variant], className),
      },
      children,
    );
  },
);
