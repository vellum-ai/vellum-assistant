import * as Dialog from "@radix-ui/react-dialog";
import { X, type LucideIcon } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { useOverlayDismiss } from "../utils/overlay-dismiss";
import { usePortalContainer } from "../utils/portal-container";

/**
 * Internal context that threads `onOpenChange` from `Root` to `Content` so
 * the overlay can explicitly dismiss the modal on a backdrop press. See
 * {@link useOverlayDismiss} for why the overlay carries handlers of its own.
 */
const ModalContext = createContext<{
  onOpenChange?: (open: boolean) => void;
}>({});

/**
 * Modal primitive built on `@radix-ui/react-dialog`.
 *
 * Compound API: `Modal.Root`, `Modal.Trigger`, `Modal.Content`,
 * `Modal.Title`, `Modal.Description`, `Modal.Close`, `Modal.Header`,
 * `Modal.Body`, `Modal.Footer`.
 *
 * Content is portaled into the element provided by the nearest
 * `<PortalContainerProvider>` so design tokens resolve inside the portal.
 * Falls back to `document.body` when no provider is mounted.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/dialog
 */

type ModalSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: "max-w-[400px]",
  md: "max-w-[560px]",
  lg: "max-w-[800px]",
  xl: "max-w-[1100px]",
};

function Root({
  onOpenChange,
  ...props
}: ComponentProps<typeof Dialog.Root>) {
  return (
    <ModalContext value={{ onOpenChange }}>
      <Dialog.Root onOpenChange={onOpenChange} {...props} />
    </ModalContext>
  );
}

function Trigger(props: ComponentProps<typeof Dialog.Trigger>) {
  return <Dialog.Trigger data-slot="modal-trigger" {...props} />;
}

interface ModalContentProps extends ComponentProps<typeof Dialog.Content> {
  size?: ModalSize;
  hideCloseButton?: boolean;
  /**
   * Accessible name for the close glyph in the corner. Defaults to the
   * untranslated "Close", which carries surfaces that sit outside a locale
   * catalog; a caller on a path that enforces translated copy hands in its own
   * `t()`'d string so the dialog announces one language throughout.
   */
  closeLabel?: string;
  overlayClassName?: string;
  /**
   * When `false`, the backdrop no longer dismisses the modal. It is the whole
   * answer: the overlay is the only thing that dismisses this dialog from
   * outside, so a non-dismissible modal pairs it with `onEscapeKeyDown` and
   * nothing else. Defaults to `true`.
   */
  dismissOnOverlayClick?: boolean;
  children?: ReactNode;
}

function Content({
  size = "md",
  hideCloseButton = false,
  closeLabel = "Close",
  overlayClassName,
  dismissOnOverlayClick = true,
  className,
  children,
  onInteractOutside,
  ref,
  ...props
}: ModalContentProps) {
  const container = usePortalContainer();
  const { onOpenChange } = useContext(ModalContext);
  const dismiss = useOverlayDismiss({
    enabled: dismissOnOverlayClick,
    onDismiss: () => onOpenChange?.(false),
  });
  return (
    <Dialog.Portal container={container ?? undefined}>
      <Dialog.Overlay
        data-slot="modal-overlay"
        className={cn(
          "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
          overlayClassName,
        )}
        {...dismiss}
      >
        <Dialog.Content
          ref={ref}
          data-slot="modal-content"
          // The backdrop covers the viewport, so a press outside this dialog
          // is a press on the backdrop, and the overlay already reports that
          // one. Leaving Radix's outside-dismissal on as well gives the dialog
          // a second way to close that it cannot see the gesture behind: the
          // check runs on the click, after React has flushed, so a nested
          // dialog or menu that closed on the same press is gone by then and
          // its press reads as an outside press on this one. One owner.
          onInteractOutside={(event) => {
            onInteractOutside?.(event);
            event.preventDefault();
          }}
          className={cn(
            "relative flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-xl border shadow-xl",
            SIZE_CLASSES[size],
            "bg-[var(--surface-lift)] border-[var(--border-base)]",
            "focus:outline-none",
            className,
          )}
          {...props}
        >
          {children}
          {!hideCloseButton ? (
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={closeLabel}
                className="absolute top-3 right-3 flex h-6 w-6 cursor-pointer items-center justify-center rounded bg-transparent text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          ) : null}
        </Dialog.Content>
      </Dialog.Overlay>
    </Dialog.Portal>
  );
}

type ModalTitleProps = ComponentProps<typeof Dialog.Title>;

function Title({
  className,
  children,
  ref,
  ...props
}: ModalTitleProps) {
  return (
    <Dialog.Title
      ref={ref}
      data-slot="modal-title"
      className={cn(
        "text-title-medium text-[var(--content-emphasised)]",
        className,
      )}
      {...props}
    >
      {/* `text-title-*` set line-height: 1, leaving no room under the
          baseline, so `truncate`'s `overflow: hidden` shears glyph
          descenders (the tail of a g/p/y in a title like "Upgrade to
          Super?"). `leading-snug` grows the line box to contain them;
          single-line ellipsis still works. Kept as a child span (rather
          than truncating the root) so callers can opt a long title back
          into wrapping via `[&>span]:whitespace-normal`. */}
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
      data-slot="modal-description"
      className={cn(
        "mt-0.5 whitespace-pre-line text-body-small-default text-[var(--content-tertiary)]",
        className,
      )}
      {...props}
    >
      {children}
    </Dialog.Description>
  );
}

function Close(props: ComponentProps<typeof Dialog.Close>) {
  return <Dialog.Close data-slot="modal-close" {...props} />;
}

interface ModalHeaderProps extends ComponentProps<"div"> {
  /**
   * Leading glyph shown beside the title/description column, sized and
   * centered against the whole column rather than just the title line:
   * matches Figma's icon+title+subtitle header layout.
   */
  icon?: LucideIcon;
}

function Header({
  icon: Icon,
  className,
  children,
  ...props
}: ModalHeaderProps) {
  return (
    <div
      data-slot="modal-header"
      // `pb-6` is the 24px gap between the header's last line (description, or
      // title when there is none) and the body, which starts with no top
      // padding of its own.
      className={cn("flex items-center gap-3 p-4 pb-6 pr-10", className)}
      {...props}
    >
      {Icon && (
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)]"
        >
          <Icon className="h-5 w-5 text-[var(--primary-base)]" />
        </span>
      )}
      {/* Title and description share one column, so the row's `items-center`
          positions the icon against the whole block. */}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function Body({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-body"
      className={cn(
        "flex-1 overflow-y-auto px-4 pb-4 text-[var(--content-default)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function Footer({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-footer"
      className={cn("flex justify-end gap-2 px-4 py-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}

const Modal = {
  Root,
  Trigger,
  Content,
  Title,
  Description,
  Close,
  Header,
  Body,
  Footer,
};

export { Modal };
export type { ModalSize, ModalContentProps, ModalTitleProps, ModalHeaderProps };
