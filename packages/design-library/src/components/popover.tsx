import * as RadixPopover from "@radix-ui/react-popover";
import { type ComponentProps } from "react";

import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";

/**
 * Compound `Popover` primitive built on `@radix-ui/react-popover`.
 *
 * Preserves Radix's focus trap, outside-click dismissal, Escape handling,
 * and `side` / `align` / `sideOffset` positioning. Content is portaled
 * into the element provided by the nearest `<PortalContainerProvider>` so
 * design tokens (CSS variables) resolve inside the portal. Falls back to
 * `document.body` when no provider is mounted.
 *
 * Usage:
 *
 * ```tsx
 * <Popover.Root>
 *   <Popover.Trigger asChild>
 *     <Button>Open</Button>
 *   </Popover.Trigger>
 *   <Popover.Content side="bottom" align="start">
 *     …
 *     <Popover.Close asChild>
 *       <Button variant="ghost">Close</Button>
 *     </Popover.Close>
 *   </Popover.Content>
 * </Popover.Root>
 * ```
 *
 * @see https://www.radix-ui.com/primitives/docs/components/popover
 */
const Root = RadixPopover.Root;

type TriggerProps = ComponentProps<typeof RadixPopover.Trigger>;

function Trigger(props: TriggerProps) {
  return <RadixPopover.Trigger data-slot="popover-trigger" {...props} />;
}

type CloseProps = ComponentProps<typeof RadixPopover.Close>;

function Close(props: CloseProps) {
  return <RadixPopover.Close data-slot="popover-close" {...props} />;
}

type AnchorProps = ComponentProps<typeof RadixPopover.Anchor>;

function Anchor(props: AnchorProps) {
  return <RadixPopover.Anchor data-slot="popover-anchor" {...props} />;
}

type ContentProps = ComponentProps<typeof RadixPopover.Content>;

function Content({
  className,
  children,
  sideOffset = 6,
  align = "center",
  ref,
  ...rest
}: ContentProps) {
  const portalContainer = usePortalContainer();
  return (
    <RadixPopover.Portal container={portalContainer ?? undefined}>
      <RadixPopover.Content
        ref={ref}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-lg bg-[var(--surface-lift)] p-2 shadow-[var(--shadow-popover)] outline-none",
          "text-[color:var(--content-default)]",
          "data-[state=open]:animate-[popoverIn_120ms_ease-out]",
          className,
        )}
        {...rest}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}

/**
 * Convenience namespace so callers write `<Popover.Root>` /
 * `<Popover.Trigger>` / `<Popover.Content>` / `<Popover.Close>` without
 * importing each symbol separately. Mirrors Radix's own compound-component
 * ergonomics.
 */
const Popover = {
  Root,
  Trigger,
  Content,
  Close,
  Anchor,
};

export { Popover, type ContentProps as PopoverContentProps };
