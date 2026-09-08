/**
 * One trigger, two presentations: a popover anchored to the trigger on a
 * pointer device, a bottom sheet on a touch phone.
 *
 * The split is not a style preference. A popover anchored near the bottom of a
 * phone screen opens into the thumb's own reach and lands under the soft
 * keyboard, which is why every existing chat control that opens a panel
 * (Assets, and the activity pill before it) hand-rolled this same branch. This
 * exists so they stop hand-rolling it: three surfaces now share one
 * implementation, so a fix to the touch path cannot land on one and miss the
 * others.
 *
 * Branches on {@link useTouchMobile} (coarse pointer AND phone width), not on
 * width alone: a narrow desktop window still wants the popover, since a bottom
 * sheet there is a modal for no reason. See `docs/PLATFORM_ADAPTATION.md`.
 */

import { useState, type ReactNode } from "react";

import { BottomSheet, Popover } from "@vellumai/design-library";

import { useTouchMobile } from "@/hooks/use-touch-mobile";

export interface AdaptivePopoverProps {
  /**
   * The control that opens the panel. Cloned onto the underlying trigger via
   * `asChild`, so it must forward refs and props: a DOM element or a component
   * built on one (the design library's `Button` qualifies).
   */
  trigger: ReactNode;
  /**
   * Sheet heading, and the panel's accessible name. Required because the touch
   * variant is a modal dialog: an unnamed sheet is announced as nothing.
   */
  title: string;
  /**
   * Keeps `title` as the accessible name but stops drawing it, for panels whose
   * body already leads with a heading of its own. The header stays in the tree
   * as `sr-only` rather than being dropped: the dialog still needs its name.
   */
  hideTitle?: boolean;
  children: ReactNode;
  /** Popover width on pointer devices. Ignored by the sheet, which is full-width. */
  className?: string;
  /** Caps the scroll region so a long list can't outgrow the viewport. */
  contentMaxHeightClassName?: string;
  /**
   * Controlled open state. Omit to let the popover own it. Supplied by callers
   * that have to react to being opened. The progress control marks a finished
   * plan as seen that way.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AdaptivePopover({
  trigger,
  title,
  children,
  className = "w-96 max-w-[calc(100vw-2rem)] p-0",
  contentMaxHeightClassName = "max-h-[320px]",
  hideTitle = false,
  open: controlledOpen,
  onOpenChange,
}: AdaptivePopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };
  const isTouchMobile = useTouchMobile();

  if (isTouchMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content className="max-h-[85dvh]">
          <BottomSheet.Header className={hideTitle ? "sr-only" : undefined}>
            <BottomSheet.Title>{title}</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">{children}</BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      {/* `align="end"`: these triggers sit against the right edge of the chat
          column, so a centred panel would resolve flush against the window. */}
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        className={className}
      >
        <div className={`overflow-y-auto ${contentMaxHeightClassName}`}>
          {children}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
