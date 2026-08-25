import { Slot } from "@radix-ui/react-slot";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { useHoverCapable } from "../utils/hover-capability";
import { usePortalContainer } from "../utils/portal-container";

/**
 * Tooltip primitive built on `@radix-ui/react-tooltip`.
 *
 * Renders a styled overlay label when the user hovers or focuses the trigger
 * element. Content is portaled into the nearest `<PortalContainerProvider>`
 * so design tokens resolve correctly.
 *
 * Nothing mounts at all where the device cannot hover. A tooltip is a hover
 * affordance: the trigger also opens on focus, and on a touch surface focus is
 * something a tap hands out, so the label arrives over the control the user
 * just aimed at and stays until something else takes focus. An autofocused
 * dialog can strand one with no tap at all. That leaves the tooltip's own
 * contents unreachable on those devices either way, so a label that carries
 * information a touch user needs belongs somewhere a thumb can get to, not in
 * a tooltip.
 *
 * The suppression stands even for a hardware keyboard on such a device:
 * keyboard focus and tap focus arrive as the same event there, and telling
 * them apart is the heuristic that fails on these devices in the first place.
 * The accessible name stays on the control itself (callers pair `tooltip`
 * with an `aria-label`), and content beyond a name belongs in a surface every
 * input can reach.
 *
 * The convenience `Tooltip` wrapper embeds its own `TooltipProvider` so
 * it works standalone. For compound usage, wrap the tree in a
 * `<TooltipProvider>` to configure global delay behaviour.
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
  const hoverCapable = useHoverCapable();

  if (!hoverCapable) {
    return null;
  }

  return (
    <RadixTooltip.Portal container={portalContainer ?? undefined}>
      <RadixTooltip.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-md bg-[var(--primary-base)] px-2 py-1 shadow-[var(--shadow-popover)]",
          "text-body-small-default text-[color:var(--content-inset)]",
          // A sentence-length tooltip would otherwise render as one
          // unbroken line the width of its text. Capped so it wraps, and
          // never wider than the space Radix reports on the chosen side, so
          // a trigger near a viewport edge does not force a reflow.
          "max-w-[min(20rem,var(--radix-tooltip-content-available-width,20rem))]",
          "text-pretty break-words",
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

export interface TooltipProps
  extends Omit<TriggerProps, "content" | "children" | "asChild"> {
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
 *
 * Embeds its own `TooltipProvider` so it works standalone (tests,
 * storybooks) without requiring a provider ancestor. When an app-level
 * `TooltipProvider` exists, the inner provider scopes its own subtree
 * with matching defaults so behaviour is consistent.
 *
 * Anything else passed in reaches the trigger, so an outer primitive that
 * composes through `asChild` (a `ContextMenu.Trigger`, a `Popover.Trigger`)
 * can still reach the element underneath. Without that, a tooltipped child
 * silently swallows the handlers such a primitive clones onto it, and the
 * element ends up with a tooltip and none of the behaviour that was wrapped
 * around it. Where the device cannot hover the tooltip is gone but that
 * forwarding is not: the child is rendered on its own, still merged with
 * whatever an outer primitive passed through.
 */
function Tooltip({
  content,
  children,
  side,
  align,
  delayDuration,
  ...triggerProps
}: TooltipProps) {
  const hoverCapable = useHoverCapable();

  if (!hoverCapable) {
    return <Slot {...triggerProps}>{children}</Slot>;
  }

  return (
    <RadixTooltip.Provider delayDuration={200} skipDelayDuration={300}>
      <Root delayDuration={delayDuration}>
        <Trigger asChild {...triggerProps}>
          {children}
        </Trigger>
        <Content side={side} align={align}>
          {content}
        </Content>
      </Root>
    </RadixTooltip.Provider>
  );
}

Tooltip.Root = Root;
Tooltip.Trigger = Trigger;
Tooltip.Content = Content;

export { Tooltip, TooltipProvider, type TooltipProviderProps };
