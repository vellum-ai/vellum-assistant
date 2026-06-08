import * as Accordion from "@radix-ui/react-accordion";
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../utils/cn";

/**
 * Generic collapsible section group — a styled
 * [Radix Accordion](https://www.radix-ui.com/primitives/docs/components/accordion)
 * compound component for expandable/collapsible content sections.
 *
 * Provides the structural layout and slide animation. Domain-specific
 * trigger styling (icons, typography, trailing slots) is the consumer's
 * responsibility.
 *
 * Usage:
 *
 *   <Collapsible.Root type="multiple" defaultValue={["section-1"]}>
 *     <Collapsible.Item value="section-1">
 *       <Collapsible.Trigger>Section 1</Collapsible.Trigger>
 *       <Collapsible.Content>{children}</Collapsible.Content>
 *     </Collapsible.Item>
 *   </Collapsible.Root>
 *
 * Slide animations use Radix's `--radix-accordion-content-height`
 * variable — keyframes are defined in `tokens.css`.
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type CollapsibleRootProps = ComponentPropsWithoutRef<
  typeof Accordion.Root
> & {
  ref?: Ref<ElementRef<typeof Accordion.Root>>;
};

function CollapsibleRoot({ className, ref, ...props }: CollapsibleRootProps) {
  return (
    <Accordion.Root
      ref={ref}
      data-slot="collapsible"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

export type CollapsibleItemProps = ComponentPropsWithoutRef<
  typeof Accordion.Item
> & {
  ref?: Ref<ElementRef<typeof Accordion.Item>>;
};

function CollapsibleItem({ className, ref, ...props }: CollapsibleItemProps) {
  return (
    <Accordion.Item
      ref={ref}
      data-slot="collapsible-item"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export type CollapsibleTriggerProps = ComponentPropsWithoutRef<
  typeof Accordion.Trigger
> & {
  ref?: Ref<ElementRef<typeof Accordion.Trigger>>;
};

function CollapsibleTrigger({
  className,
  ref,
  ...props
}: CollapsibleTriggerProps) {
  return (
    <Accordion.Header data-slot="collapsible-header" className="flex">
      <Accordion.Trigger
        ref={ref}
        data-slot="collapsible-trigger"
        className={cn(
          "flex min-w-0 flex-1 items-center",
          "cursor-pointer select-none",
          "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
          className,
        )}
        {...props}
      />
    </Accordion.Header>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type CollapsibleContentProps = ComponentPropsWithoutRef<
  typeof Accordion.Content
> & {
  ref?: Ref<ElementRef<typeof Accordion.Content>>;
};

function CollapsibleContent({
  className,
  ref,
  children,
  ...props
}: CollapsibleContentProps) {
  return (
    <Accordion.Content
      ref={ref}
      data-slot="collapsible-content"
      className={cn("collapsible-content overflow-hidden", className)}
      {...props}
    >
      {children}
    </Accordion.Content>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const Collapsible = {
  Root: CollapsibleRoot,
  Item: CollapsibleItem,
  Trigger: CollapsibleTrigger,
  Content: CollapsibleContent,
};
