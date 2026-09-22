import * as Accordion from "@radix-ui/react-accordion";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronRight } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../utils/cn";

/**
 * One trigger that shows and hides one region: an "Advanced" row in a form, a
 * "Show details" line under a card.
 *
 * `Collapsible` is an accordion, so it needs a `Root` that owns a set of values
 * and an `Item` per section. That is the right shape for a list of sections and
 * too much ceremony for a single toggle, which is why call sites kept
 * hand-rolling a chevron button around `useState`, usually without
 * `aria-expanded`. `Disclosure` is that single toggle with the wiring done: the
 * trigger announces its state, points at the region it controls, and the region
 * slides with the same animation `Collapsible` uses.
 *
 * It is built on the Radix accordion the library already ships (one item, in
 * `single` + `collapsible` mode) rather than on a second Radix package, so the
 * two components share their keyframes and their behaviour.
 *
 * Usage:
 *
 *   <Disclosure.Root>
 *     <Disclosure.Trigger>Advanced</Disclosure.Trigger>
 *     <Disclosure.Content className="mt-2 space-y-4">{fields}</Disclosure.Content>
 *   </Disclosure.Root>
 *
 * Uncontrolled by default (`defaultOpen`); pass `open` + `onOpenChange` to own
 * the state. `Content` unmounts while closed. Pass `keepMounted` when the
 * region holds state that has to survive a close, such as half-filled inputs.
 */

/** The accordion needs a value per item. There is only ever this one. */
const ITEM_VALUE = "content";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface DisclosureRootProps
  extends Omit<
    ComponentPropsWithoutRef<"div">,
    "defaultValue" | "dir" | "onChange"
  > {
  ref?: Ref<HTMLDivElement>;
  /** Controlled open state. Pair with `onOpenChange`. */
  open?: boolean;
  /** Initial open state when uncontrolled. Defaults to `false`. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Blocks the trigger and dims it. */
  disabled?: boolean;
  children?: ReactNode;
}

function DisclosureRoot({
  open,
  defaultOpen = false,
  onOpenChange,
  disabled,
  className,
  children,
  ref,
  ...props
}: DisclosureRootProps) {
  return (
    <Accordion.Root
      {...props}
      ref={ref}
      type="single"
      collapsible
      disabled={disabled}
      value={open === undefined ? undefined : open ? ITEM_VALUE : ""}
      defaultValue={
        open === undefined && defaultOpen ? ITEM_VALUE : undefined
      }
      onValueChange={(value) => onOpenChange?.(value === ITEM_VALUE)}
      data-slot="disclosure"
      className={cn("flex w-full flex-col", className)}
    >
      <Accordion.Item
        value={ITEM_VALUE}
        data-slot="disclosure-item"
        className="flex flex-col"
      >
        {children}
      </Accordion.Item>
    </Accordion.Root>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const disclosureTriggerVariants = cva(
  [
    "group/disclosure-trigger inline-flex w-fit max-w-full items-center gap-1 rounded-sm text-left",
    "cursor-pointer select-none transition-colors",
    "text-[color:var(--content-secondary)] hover:text-[color:var(--content-default)]",
    "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
    "disabled:cursor-not-allowed disabled:text-[color:var(--content-disabled)]",
  ].join(" "),
  {
    variants: {
      size: {
        small: "text-body-small-default",
        medium: "text-body-medium-default",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      size: "small",
      fullWidth: false,
    },
  },
);

type DisclosureTriggerVariantProps = VariantProps<
  typeof disclosureTriggerVariants
>;

export type DisclosureTriggerSize = NonNullable<
  DisclosureTriggerVariantProps["size"]
>;

export type DisclosureTriggerProps = ComponentPropsWithoutRef<
  typeof Accordion.Trigger
> & {
  ref?: Ref<ElementRef<typeof Accordion.Trigger>>;
  /** Type scale of the label. Defaults to `small`. */
  size?: DisclosureTriggerSize;
  /**
   * Stretch the hit area across the row. Off by default, so a click beside a
   * short label does not toggle the region.
   */
  fullWidth?: boolean;
  /**
   * Hide the leading chevron, for a trigger that draws its own affordance.
   * With `asChild` the chevron is never drawn: the child owns its content.
   */
  hideChevron?: boolean;
};

function DisclosureTrigger({
  size,
  fullWidth,
  hideChevron = false,
  asChild,
  className,
  children,
  ref,
  ...props
}: DisclosureTriggerProps) {
  return (
    // Radix renders the header as an `h3`. A lone toggle inside a form is not
    // a section heading, and an `h3` there would put it in the page outline.
    <Accordion.Header asChild>
      <div data-slot="disclosure-header" className="flex">
        <Accordion.Trigger
          {...props}
          ref={ref}
          asChild={asChild}
          data-slot="disclosure-trigger"
          className={cn(
            disclosureTriggerVariants({ size, fullWidth }),
            className,
          )}
        >
          {asChild ? (
            children
          ) : (
            <>
              {hideChevron ? null : (
                <ChevronRight
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/disclosure-trigger:rotate-90 motion-reduce:transition-none"
                />
              )}
              {children}
            </>
          )}
        </Accordion.Trigger>
      </div>
    </Accordion.Header>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type DisclosureContentProps = Omit<
  ComponentPropsWithoutRef<typeof Accordion.Content>,
  "forceMount"
> & {
  ref?: Ref<ElementRef<typeof Accordion.Content>>;
  /**
   * Keep the region in the DOM while closed, hidden, so state inside it
   * survives. The close is then immediate rather than animated: the slide-up
   * plays on an element that is on its way out, and this one never leaves.
   */
  keepMounted?: boolean;
};

function DisclosureContent({
  keepMounted = false,
  className,
  children,
  ref,
  ...props
}: DisclosureContentProps) {
  return (
    <Accordion.Content
      {...props}
      ref={ref}
      forceMount={keepMounted ? true : undefined}
      data-slot="disclosure-content"
      className={cn(
        "overflow-hidden",
        keepMounted ? "data-[state=closed]:hidden" : "collapsible-content",
      )}
    >
      {/* Spacing classes live on an inner box. On the animated element a
          margin would sit outside the height the slide measures, and the
          region would jump by that margin at the end of every open. */}
      <div className={className}>{children}</div>
    </Accordion.Content>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const Disclosure = {
  Root: DisclosureRoot,
  Trigger: DisclosureTrigger,
  Content: DisclosureContent,
};

export { disclosureTriggerVariants };
