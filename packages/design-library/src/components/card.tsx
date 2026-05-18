import { Slot } from "@radix-ui/react-slot";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn.js";
import { Typography } from "./typography.js";

type CardPadding = "sm" | "md" | "lg";

const PADDING_CLASSES: Record<CardPadding, string> = {
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export interface CardRootProps extends HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  bordered?: boolean;
  elevated?: boolean;
  noPadding?: boolean;
  clipContents?: boolean;
  asChild?: boolean;
  children?: ReactNode;
}

interface CardSectionProps extends HTMLAttributes<HTMLDivElement> {
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

const CardRoot = forwardRef<HTMLDivElement, CardRootProps>(function CardRoot(
  {
    padding = "md",
    bordered = true,
    elevated = false,
    noPadding = false,
    clipContents = false,
    asChild = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  const Comp = asChild ? Slot : "div";
  const hasSections = childrenContainSections(children);
  return (
    <Comp
      {...rest}
      ref={ref}
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
});

const CardHeader = forwardRef<HTMLDivElement, CardSectionProps>(
  function CardHeader({ padding = "md", className, children, ...rest }, ref) {
    return (
      <Typography
        {...rest}
        ref={ref}
        variant="title-small"
        as="div"
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
  },
);

const CardBody = forwardRef<HTMLDivElement, CardSectionProps>(function CardBody(
  { padding = "md", className, children, ...rest },
  ref,
) {
  return (
    <div
      {...rest}
      ref={ref}
      className={cn(PADDING_CLASSES[padding], className)}
    >
      {children}
    </div>
  );
});

const CardFooter = forwardRef<HTMLDivElement, CardSectionProps>(
  function CardFooter({ padding = "md", className, children, ...rest }, ref) {
    return (
      <div
        {...rest}
        ref={ref}
        className={cn(
          PADDING_CLASSES[padding],
          "border-t border-[var(--border-base)]",
          className,
        )}
      >
        {children}
      </div>
    );
  },
);

const CardDefault = forwardRef<HTMLDivElement, CardRootProps>(function Card(
  { children, padding = "md", ...rest },
  ref,
) {
  return (
    <CardRoot ref={ref} padding={padding} {...rest}>
      <CardBody padding={padding}>{children}</CardBody>
    </CardRoot>
  );
});

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
