import { Slot } from "@radix-ui/react-slot";
import {
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";
import { Typography } from "./typography";

type CardPadding = "sm" | "md" | "lg";

const PADDING_CLASSES: Record<CardPadding, string> = {
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export interface CardRootProps extends ComponentProps<"div"> {
  padding?: CardPadding;
  bordered?: boolean;
  elevated?: boolean;
  noPadding?: boolean;
  clipContents?: boolean;
  asChild?: boolean;
  children?: ReactNode;
}

interface CardSectionProps extends ComponentProps<"div"> {
  padding?: CardPadding;
  children?: ReactNode;
}

const BASE_SURFACE_CLASSES = [
  "bg-[var(--surface-lift)]",
  "text-[color:var(--content-default)]",
  "rounded-xl",
].join(" ");

function rootClasses({
  padding,
  bordered,
  elevated,
  hasSections,
  noPadding,
  clipContents,
}: {
  padding: CardPadding;
  bordered: boolean;
  elevated: boolean;
  hasSections: boolean;
  noPadding: boolean;
  clipContents: boolean;
}): string {
  return cn(
    BASE_SURFACE_CLASSES,
    bordered ? "border border-[var(--border-base)]" : "border border-transparent",
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
  bordered = true,
  elevated = false,
  noPadding = false,
  clipContents = false,
  asChild = false,
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
      className={cn(
        rootClasses({
          padding,
          bordered,
          elevated,
          hasSections,
          noPadding,
          clipContents,
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

export { Card, CardRoot, CardHeader, CardBody, CardFooter };
