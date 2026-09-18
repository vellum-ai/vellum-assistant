import * as Dialog from "@radix-ui/react-dialog";
import { type LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";
import { useOverlayDismiss } from "../utils/overlay-dismiss";
import { usePortalContainer } from "../utils/portal-container";

/**
 * Internal context that threads `onOpenChange` from `Root` to `Content` so
 * the overlay can explicitly dismiss the sheet on a backdrop press. See
 * {@link useOverlayDismiss} for why the overlay carries handlers of its own.
 */
const BottomSheetContext = createContext<{
  open?: boolean;
  /** Radix's own default, and what decides whether a backdrop exists at all. */
  modal?: boolean;
  onOpenChange?: (open: boolean) => void;
}>({});

/**
 * `BottomSheet` primitive built on `@radix-ui/react-dialog`.
 *
 * A full-width dialog anchored to the bottom of the viewport with rounded
 * top corners and a slide-up entrance animation. Designed for mobile
 * surfaces like menus, pickers, and confirmation sheets.
 *
 * The default height band (`min-h`/`max-h` on `Content`) suits those: enough
 * floor that one row still reads as a sheet, and a ceiling that leaves the
 * page visible behind it. A sheet that should rest against something specific
 * instead (below a header, say) overrides that band and sets its own `top`;
 * `className` merges over the defaults.
 *
 * Compound API: `BottomSheet.Root`, `BottomSheet.Trigger`,
 * `BottomSheet.Content`, `BottomSheet.Title`, `BottomSheet.Description`,
 * `BottomSheet.Close`, `BottomSheet.Grabber`, `BottomSheet.Header`,
 * `BottomSheet.Body`, `BottomSheet.Footer`.
 *
 * Adoption is consumer-driven: consumers decide whether to mount
 * `BottomSheet.Root` or an anchored surface such as `Popover.Root`. That
 * choice belongs to the input-capability axis (a narrow viewport with a
 * coarse pointer), not to viewport width alone, so a narrow desktop window
 * driven by a mouse keeps the anchored surface.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/dialog
 */

function Root({
  open: controlledOpen,
  defaultOpen = false,
  modal = true,
  onOpenChange,
  ...props
}: ComponentProps<typeof Dialog.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (next === open) {
      return;
    }
    if (controlledOpen === undefined) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };
  return (
    <BottomSheetContext value={{ open, modal, onOpenChange: setOpen }}>
      <Dialog.Root open={open} modal={modal} onOpenChange={setOpen} {...props} />
    </BottomSheetContext>
  );
}

function Trigger(props: ComponentProps<typeof Dialog.Trigger>) {
  return <Dialog.Trigger data-slot="bottom-sheet-trigger" {...props} />;
}

interface BottomSheetContentProps extends ComponentProps<
  typeof Dialog.Content
> {
  /**
   * Detail sheets leave context above the surface and support handle dragging.
   * Set --bottom-sheet-bottom-inset to extend the surface through frame padding.
   */
  variant?: "default" | "detail";
  overlayClassName?: string;
  /**
   * Whether the sheet insets its content. Sheets carrying rows of text and
   * controls want the inset; sheets whose content is itself a surface (a
   * full-bleed color fill, a canvas, artwork that must reach the rounded
   * corners) supply their own spacing and set this false. The safe-area
   * allowance goes with it, so an unpadded sheet is responsible for keeping
   * its own content clear of the home indicator.
   */
  padded?: boolean;
  children?: ReactNode;
}

function Content({
  variant = "default",
  overlayClassName,
  className,
  padded = true,
  children,
  onInteractOutside,
  ref,
  style,
  ...props
}: BottomSheetContentProps) {
  const container = usePortalContainer();
  const { open, modal, onOpenChange } = useContext(BottomSheetContext);
  const dismiss = useOverlayDismiss({
    onDismiss: () => onOpenChange?.(false),
  });
  return (
    <Dialog.Portal container={container ?? undefined}>
      <Dialog.Overlay
        data-slot="bottom-sheet-overlay"
        data-variant={variant}
        className={cn("fixed inset-0 z-50 bg-black/50", overlayClassName)}
        {...dismiss}
      />
      <Dialog.Content
        ref={ref}
        data-slot="bottom-sheet-content"
        data-variant={variant}
        // A modal sheet's backdrop covers the viewport, so a press outside the
        // sheet is a press on the backdrop, and the overlay already reports
        // that one. Leaving Radix's outside-dismissal on as well closes the
        // sheet twice for one tap, and gives it a second way out that cannot
        // see the gesture behind: the check runs on the click, after React has
        // flushed, so a menu or dialog that closed on the same press is gone
        // by then and its press reads as a press outside the sheet. A
        // non-modal sheet has no backdrop, so there Radix stays the only
        // owner.
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (modal) {
            event.preventDefault();
          }
        }}
        inert={variant === "detail" && !open ? true : undefined}
        style={
          variant === "detail" ? { pointerEvents: "none", ...style } : style
        }
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex w-full flex-col focus:outline-none",
          // Sheets keep a floor so short content (e.g. a single row) still
          // reads as a sheet rather than a sliver pinned to the bottom edge.
          variant === "detail"
            ? "pointer-events-none h-[100dvh] justify-end"
            : "min-h-[min(280px,45dvh)] max-h-[50dvh] rounded-t-[24px] border-t bg-[var(--surface-lift)] border-[var(--border-base)] shadow-xl data-[state=open]:animate-[bottomSheetIn_180ms_ease-out]",
          className,
        )}
        {...props}
      >
        <div
          data-slot="bottom-sheet-content-inner"
          className={cn(
            "flex min-h-0 flex-col",
            variant === "detail"
              ? "pointer-events-auto mb-[calc(-1*var(--bottom-sheet-bottom-inset,0px))] h-[calc(90%+var(--bottom-sheet-bottom-inset,0px))] pb-[var(--bottom-sheet-bottom-inset,0px)] overflow-hidden rounded-t-[24px] border-t border-[var(--border-base)] bg-[var(--surface-lift)] shadow-xl"
              : "flex-1",
            padded &&
              "px-4 pt-4 pb-[calc(16px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]",
          )}
        >
          {variant === "detail" && (
            <BottomSheetDragHandle onDismiss={() => onOpenChange?.(false)} />
          )}
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

const DISMISS_DISTANCE_PX = 100;

interface BottomSheetDragHandleProps {
  onDismiss: () => void;
}

/** Owns only handle drags; the sheet's body retains native scrolling. */
function BottomSheetDragHandle({ onDismiss }: BottomSheetDragHandleProps) {
  const gesture = useRef<{
    pointerId: number;
    startY: number;
    offset: number;
    sheet: HTMLElement;
  } | null>(null);

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    gesture.current = null;
    delete active.sheet.dataset.dragging;
    if (!cancelled && active.offset >= DISMISS_DISTANCE_PX) {
      onDismiss();
    } else {
      active.sheet.dataset.snapping = "true";
      active.sheet.style.setProperty("--bottom-sheet-drag-offset", "0px");
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      data-slot="bottom-sheet-drag-handle"
      aria-hidden="true"
      className="flex h-8 shrink-0 cursor-grab touch-none select-none items-center justify-center active:cursor-grabbing"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) {
          return;
        }
        const sheet = event.currentTarget.closest<HTMLElement>(
          '[data-slot="bottom-sheet-content"]',
        );
        if (!sheet) {
          return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        delete sheet.dataset.snapping;
        sheet.dataset.dragging = "true";
        gesture.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          offset: 0,
          sheet,
        };
      }}
      onPointerMove={(event) => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) {
          return;
        }
        active.offset = Math.max(0, event.clientY - active.startY);
        active.sheet.style.setProperty(
          "--bottom-sheet-drag-offset",
          `${active.offset}px`,
        );
      }}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
    >
      <div className="h-1 w-14 rounded-full bg-[var(--border-element)]" />
    </div>
  );
}

interface BottomSheetTitleProps extends ComponentProps<typeof Dialog.Title> {
  icon?: LucideIcon;
}

function Title({
  icon: Icon,
  className,
  children,
  ref,
  ...props
}: BottomSheetTitleProps) {
  return (
    <Dialog.Title
      ref={ref}
      data-slot="bottom-sheet-title"
      className={cn(
        "flex items-center gap-3 text-title-medium text-[var(--content-default)]",
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--primary-base) 16%, transparent)",
          }}
        >
          <Icon className="h-5 w-5 text-[var(--primary-base)]" />
        </span>
      ) : null}
      {/* `text-title-*` set line-height: 1, so `truncate`'s `overflow: hidden`
          shears glyph descenders (the tail of a g/p/y). `leading-snug` grows
          the line box to contain them; single-line ellipsis still works. */}
      <span className="min-w-0 truncate leading-snug">{children}</span>
    </Dialog.Title>
  );
}

function Description({
  className,
  children,
  ref,
  ...props
}: ComponentProps<typeof Dialog.Description>) {
  return (
    <Dialog.Description
      ref={ref}
      data-slot="bottom-sheet-description"
      className={cn(
        "mt-1 whitespace-pre-line text-body-medium-lighter text-[var(--content-secondary)]",
        className,
      )}
      {...props}
    >
      {children}
    </Dialog.Description>
  );
}

function Close(props: ComponentProps<typeof Dialog.Close>) {
  return <Dialog.Close data-slot="bottom-sheet-close" {...props} />;
}

/**
 * The pill at the top edge that reads as "this panel came up from the bottom".
 * Opt-in, so sheets that already open under a header or carry their own
 * chrome are unchanged.
 *
 * Decorative only: it is not a drag target, and dismissal stays with the
 * overlay, Escape, and whatever close control the header carries. Hidden from
 * assistive technology for that reason, rather than announced as a control
 * that does nothing.
 */
function Grabber({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-sheet-grabber"
      aria-hidden="true"
      className={cn(
        "mx-auto h-1 w-14 shrink-0 rounded-full bg-[var(--border-element)]",
        className,
      )}
      {...props}
    />
  );
}

function Header({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-sheet-header"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function Body({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-sheet-body"
      className={cn(
        "flex-1 overflow-y-auto pt-4 text-[var(--content-default)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function Footer({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-sheet-footer"
      className={cn("flex justify-end gap-2 pt-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}

const BottomSheet = {
  Root,
  Trigger,
  Content,
  Title,
  Description,
  Close,
  Grabber,
  Header,
  Body,
  Footer,
};

export { BottomSheet };
export type { BottomSheetContentProps, BottomSheetTitleProps };
