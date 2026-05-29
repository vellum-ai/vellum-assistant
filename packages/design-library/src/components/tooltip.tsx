import * as RadixTooltip from "@radix-ui/react-tooltip";
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";

/**
 * Tooltip primitive built on `@radix-ui/react-tooltip`.
 *
 * Renders a styled overlay label when the user hovers or focuses the trigger
 * element. Content is portaled into the nearest `<PortalContainerProvider>`
 * so design tokens resolve correctly.
 *
 * **Requires `<TooltipProvider>`** at the application root to configure
 * global delay behaviour (`delayDuration`, `skipDelayDuration`).
 *
 * Quick usage (string label wrapping a single trigger):
 *
 * ```tsx
 * <Tooltip content="Deploy">
 *   <Button iconOnly={<Globe />} />
 * </Tooltip>
 * ```
 *
 * Compound usage (custom content or positioning):
 *
 * ```tsx
 * <Tooltip.Root>
 *   <Tooltip.Trigger asChild>
 *     <Button>Hover me</Button>
 *   </Tooltip.Trigger>
 *   <Tooltip.Content side="right">Rich content here</Tooltip.Content>
 * </Tooltip.Root>
 * ```
 *
 * @see https://www.radix-ui.com/primitives/docs/components/tooltip
 */

type TooltipProviderProps = ComponentProps<typeof RadixTooltip.Provider>;

function TooltipProvider(props: TooltipProviderProps) {
  return <RadixTooltip.Provider data-slot="tooltip-provider" {...props} />;
}

const Root = RadixTooltip.Root;

type TriggerProps = ComponentProps<typeof RadixTooltip.Trigger>;

function Trigger(props: TriggerProps) {
  return <RadixTooltip.Trigger data-slot="tooltip-trigger" {...props} />;
}

export type TooltipContentProps = ComponentProps<typeof RadixTooltip.Content>;

function Content({
  className,
  children,
  sideOffset = 6,
  ref,
  ...rest
}: TooltipContentProps) {
  const portalContainer = usePortalContainer();
  return (
    <RadixTooltip.Portal container={portalContainer ?? undefined}>
      <RadixTooltip.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-md bg-[var(--primary-base)] px-2 py-1 shadow-[var(--shadow-popover)]",
          "text-body-small-default text-[color:var(--content-inset)]",
          "data-[state=delayed-open]:animate-[popoverIn_120ms_ease-out]",
          "data-[state=instant-open]:animate-[popoverIn_60ms_ease-out]",
          className,
        )}
        {...rest}
      >
        {children}
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  );
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipContentProps["side"];
  align?: TooltipContentProps["align"];
  delayDuration?: number;
}

/**
 * Convenience wrapper that pairs a trigger element with a text tooltip.
 * Wraps the child with `asChild` so the trigger's DOM element is the
 * child itself (no extra wrapper `<button>`).
 */
function Tooltip({ content, children, side, align, delayDuration }: TooltipProps) {
  return (
    <Root delayDuration={delayDuration}>
      <Trigger asChild>{children}</Trigger>
      <Content side={side} align={align}>
        {content}
      </Content>
    </Root>
  );
}

Tooltip.Root = Root;
Tooltip.Trigger = Trigger;
Tooltip.Content = Content;

export { Tooltip, TooltipProvider, type TooltipProviderProps };
