import * as Dialog from "@radix-ui/react-dialog";
import { X, type LucideIcon } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";

/**
 * Internal context that threads `onOpenChange` from `Root` to `Content` so
 * the overlay can explicitly dismiss the modal on click.
 *
 * iOS Safari/WKWebView only fires `click` events from elements it considers
 * "clickable". Radix's DismissableLayer defers touch-dismiss to a `click`
 * listener on the document, which never fires from the plain overlay div on
 * iOS. An explicit `onClick` on the overlay ensures the modal dismisses on
 * tap-outside.
 *
 * @see https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/HandlingEvents/HandlingEvents.html
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
  overlayClassName?: string;
  /**
   * When `false`, clicking the overlay backdrop no longer dismisses the modal.
   * Pair with Radix's `onInteractOutside`/`onEscapeKeyDown` (passed through to
   * `Dialog.Content`) to make a modal fully non-dismissible. Defaults to `true`.
   */
  dismissOnOverlayClick?: boolean;
  children?: ReactNode;
}

function Content({
  size = "md",
  hideCloseButton = false,
  overlayClassName,
  dismissOnOverlayClick = true,
  className,
  children,
  ref,
  ...props
}: ModalContentProps) {
  const container = usePortalContainer();
  const { onOpenChange } = useContext(ModalContext);
  return (
    <Dialog.Portal container={container ?? undefined}>
      <Dialog.Overlay
        data-slot="modal-overlay"
        className={cn(
          "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
          overlayClassName,
        )}
        onClick={(e) => {
          if (!dismissOnOverlayClick) return;
          if (e.target === e.currentTarget) onOpenChange?.(false);
        }}
      >
        <Dialog.Content
          ref={ref}
          data-slot="modal-content"
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
                aria-label="Close"
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

interface ModalTitleProps extends ComponentProps<typeof Dialog.Title> {
  icon?: LucideIcon;
}

function Title({
  icon: Icon,
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
      <span className="min-w-0 truncate">{children}</span>
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
  return <Dialog.Close data-slot="modal-close" {...props} />;
}

function Header({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-header"
      className={cn("flex flex-col gap-1 p-4 pr-10", className)}
      {...props}
    >
      {children}
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
export type { ModalSize, ModalContentProps, ModalTitleProps };
