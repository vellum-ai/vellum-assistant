import { ChevronRight, type LucideIcon } from "lucide-react";
import {
    useCallback,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type Ref,
} from "react";

import { BottomSheet, ContextMenu } from "@vellumai/design-library";
import {
    Collapsible,
    type CollapsibleItemProps,
    type CollapsibleRootProps,
} from "@vellumai/design-library/components/collapsible";
import { cn } from "@vellumai/design-library/utils/cn";

import { useLongPress } from "@/hooks/use-long-press";
import { isPointerCoarse } from "@/utils/pointer";

/**
 * Navigation-specific collapsible section — composes the design library
 * `Collapsible` primitive with sidebar-tuned trigger styling:
 *
 *   - Leading icon that swaps to a disclosure chevron on hover
 *     (matching macOS SidebarSectionHeader). The original icon is
 *     always visible when not hovered, regardless of expanded state.
 *   - Optional `trailing` slot for an ellipsis menu or other per-row
 *     affordance. Pointer events are isolated so clicking trailing
 *     content doesn't toggle the section.
 *   - Optional header menu, in two surfaces: `contextMenuContent`
 *     (desktop right-click) and `touchMenuContent` (touch long-press →
 *     bottom sheet). Supply both so the actions are reachable on every
 *     pointer type — Radix `ContextMenu` alone renders a pointer-positioned
 *     popover on touch, which is the wrong surface on mobile. Mirrors the
 *     conversation-row long-press pattern.
 *   - No hover background — the chevron swap is the affordance.
 *
 * Usage:
 *
 *   <CollapsibleNavSection.Root type="multiple" defaultValue={["scheduled"]}>
 *     <CollapsibleNavSection.Section
 *       value="scheduled"
 *       icon={Clock}
 *       label="Scheduled"
 *       trailing={<MenuButton />}
 *     >
 *       {childRows}
 *     </CollapsibleNavSection.Section>
 *   </CollapsibleNavSection.Root>
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function CollapsibleNavSectionRoot({
  className,
  ref,
  ...props
}: CollapsibleRootProps) {
  return (
    <Collapsible.Root
      ref={ref}
      className={cn("gap-2", className)}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface CollapsibleNavSectionSectionProps
  extends Omit<CollapsibleItemProps, "children"> {
  value: string;
  icon?: LucideIcon;
  label: string;
  trailing?: ReactNode;
  contextMenuContent?: ReactNode;
  /**
   * Touch equivalent of `contextMenuContent` — rendered as the body of a
   * long-press bottom sheet. Receives a `close` callback so rows can dismiss
   * the sheet after running their action.
   */
  touchMenuContent?: (close: () => void) => ReactNode;
  /** Accessible title for the long-press sheet. Defaults to `label`. */
  touchMenuTitle?: string;
  /**
   * Activity indicator rendered inline in the header, but only while the
   * section is collapsed — when open, the child rows show their own
   * indicators, so a header dot would be redundant.
   */
  collapsedIndicator?: ReactNode;
  children?: ReactNode;
  contentClassName?: string;
  ref?: Ref<HTMLDivElement>;
}

function CollapsibleNavSectionSection({
  value,
  icon: Icon,
  label,
  trailing,
  contextMenuContent,
  touchMenuContent,
  touchMenuTitle,
  collapsedIndicator,
  children,
  className,
  contentClassName,
  ref,
  ...itemProps
}: CollapsibleNavSectionSectionProps) {
  // Touch: long-pressing the header opens the actions bottom sheet. The
  // compatibility click the browser emits on touchend would otherwise reach
  // the Collapsible.Trigger underneath and toggle the section, so a capture
  // handler swallows it (same guard as `conversation-row.tsx`).
  const [longPressOpen, setLongPressOpen] = useState(false);
  const longPressFiredRef = useRef(false);
  const longPressHandlers = useLongPress(
    () => {
      longPressFiredRef.current = true;
      setLongPressOpen(true);
    },
    undefined,
    {
      // The header IS a `<button>` (Collapsible.Trigger), so the default
      // interactive-target skip would suppress the gesture entirely. Opt out
      // and instead skip only the trailing "…" control, which owns its taps.
      ignoreInteractiveTarget: true,
      shouldSkip: (target) =>
        Boolean(
          target?.closest('[data-slot="collapsible-nav-section-trailing"]'),
        ),
    },
  );
  const handleLongPressOpenChange = useCallback((open: boolean) => {
    setLongPressOpen(open);
    if (!open) {
      longPressFiredRef.current = false;
    }
  }, []);
  const handleClickCapture = useCallback((event: ReactMouseEvent) => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const headerEl = (
    <div data-slot="collapsible-nav-section-header" className="flex items-center justify-between">
      <Collapsible.Trigger
        className={cn(
          "group h-[30px] max-md:h-auto gap-[4px] max-md:gap-[8px]",
          "rounded-[6px] p-[6px] max-md:px-2 max-md:py-3",
          "text-left text-body-medium-default max-md:text-body-large-default",
          "text-[var(--content-tertiary)]",
        )}
      >
        <span className="relative inline-flex size-[14px] shrink-0 items-center justify-center">
          {Icon ? (
            <Icon
              size={14}
              aria-hidden
              className={cn(
                "absolute inset-0 m-auto transition-opacity",
                "text-[var(--content-tertiary)]",
                "group-hover:opacity-0 group-focus-visible:opacity-0",
              )}
            />
          ) : null}
          <ChevronRight
            size={14}
            aria-hidden
            className={cn(
              "absolute inset-0 m-auto transition-[opacity,transform]",
              "text-[var(--content-tertiary)]",
              Icon
                ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                : "opacity-100",
              "group-data-[state=open]:rotate-90",
            )}
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {collapsedIndicator ? (
          <span className="ml-1 flex shrink-0 items-center group-data-[state=open]:hidden">
            {collapsedIndicator}
          </span>
        ) : null}
      </Collapsible.Trigger>
      {trailing ? (
        <span
          data-slot="collapsible-nav-section-trailing"
          className="flex items-center shrink-0 pr-[6px] max-md:pr-2"
          onClick={(event) => event.stopPropagation()}
        >
          {trailing}
        </span>
      ) : null}
    </div>
  );

  // Touch devices replace the right-click ContextMenu with a long-press sheet.
  // The sheet renders as a *sibling* of the capture wrapper, not a child:
  // React propagates events through the React tree even for portaled content,
  // so keeping it outside the boundary stops `handleClickCapture` from
  // swallowing the first tap on a sheet action.
  const isTouch = isPointerCoarse();

  let header: ReactNode = headerEl;
  if (isTouch && touchMenuContent) {
    header = (
      <>
        <div
          className="contents"
          onClickCapture={handleClickCapture}
          onTouchStart={longPressHandlers.onTouchStart}
          onTouchMove={longPressHandlers.onTouchMove}
          onTouchEnd={longPressHandlers.onTouchEnd}
          onTouchCancel={longPressHandlers.onTouchCancel}
        >
          {headerEl}
        </div>
        <BottomSheet.Root
          open={longPressOpen}
          onOpenChange={handleLongPressOpenChange}
        >
          <BottomSheet.Content>
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>
                {touchMenuTitle ?? label} actions
              </BottomSheet.Title>
            </BottomSheet.Header>
            <BottomSheet.Body className="pt-0">
              {touchMenuContent(() => setLongPressOpen(false))}
            </BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
      </>
    );
  } else if (!isTouch && contextMenuContent) {
    header = (
      <ContextMenu.Root>
        <ContextMenu.Trigger>{headerEl}</ContextMenu.Trigger>
        <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
          {contextMenuContent}
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
  }

  return (
    <Collapsible.Item
      ref={ref}
      data-slot="collapsible-nav-section-section"
      value={value}
      className={className}
      {...itemProps}
    >
      {header}
      <Collapsible.Content className={contentClassName}>
        {children}
      </Collapsible.Content>
    </Collapsible.Item>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const CollapsibleNavSection = {
  Root: CollapsibleNavSectionRoot,
  Section: CollapsibleNavSectionSection,
};

export type CollapsibleNavSectionRootProps = CollapsibleRootProps;
