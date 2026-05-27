import * as Dialog from "@radix-ui/react-dialog";
import { type LucideIcon } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";

/**
 * Internal context that threads `onOpenChange` from `Root` to `Content` so
 * the overlay can explicitly dismiss the sheet on click.
 *
 * iOS Safari/WKWebView only fires `click` events from elements it considers
 * "clickable" (has a click handler, cursor: pointer, or is natively
 * interactive). Radix's DismissableLayer defers touch-dismiss to a `click`
 * listener on the document, which never fires from the plain overlay div on
 * iOS. An explicit `onClick` on the overlay makes it "clickable" per iOS's
 * rules and ensures the sheet dismisses on tap-outside.
 *
 * @see https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/HandlingEvents/HandlingEvents.html
 */
const BottomSheetContext = createContext<{
  onOpenChange?: (open: boolean) => void;
}>({});

/**
 * `BottomSheet` primitive built on `@radix-ui/react-dialog`.
 *
 * A full-width dialog anchored to the bottom of the viewport with rounded
 * top corners and a slide-up entrance animation. Designed for mobile
 * surfaces like menus, pickers, and confirmation sheets.
 *
 * Compound API: `BottomSheet.Root`, `BottomSheet.Trigger`,
 * `BottomSheet.Content`, `BottomSheet.Title`, `BottomSheet.Description`,
 * `BottomSheet.Close`, `BottomSheet.Header`, `BottomSheet.Body`,
 * `BottomSheet.Footer`.
 *
 * Adoption is consumer-driven — consumers decide whether to mount
 * `BottomSheet.Root` vs `Popover.Root` based on `useIsMobile()`.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/dialog
 */

function Root({
  onOpenChange,
  ...props
}: ComponentProps<typeof Dialog.Root>) {
  return (
    <BottomSheetContext value={{ onOpenChange }}>
      <Dialog.Root onOpenChange={onOpenChange} {...props} />
    </BottomSheetContext>
  );
}

function Trigger(props: ComponentProps<typeof Dialog.Trigger>) {
  return <Dialog.Trigger data-slot="bottom-sheet-trigger" {...props} />;
}

interface BottomSheetContentProps extends ComponentProps<typeof Dialog.Content> {
  overlayClassName?: string;
  children?: ReactNode;
}

function Content({
  overlayClassName,
  className,
  children,
  ref,
  ...props
}: BottomSheetContentProps) {
  const container = usePortalContainer();
  const { onOpenChange } = useContext(BottomSheetContext);
  return (
    <Dialog.Portal container={container ?? undefined}>
      <Dialog.Overlay
        data-slot="bottom-sheet-overlay"
        className={cn("fixed inset-0 z-50 bg-black/50", overlayClassName)}
        onClick={() => onOpenChange?.(false)}
      />
      <Dialog.Content
        ref={ref}
        data-slot="bottom-sheet-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex w-full flex-col rounded-t-[24px] border-t bg-[var(--surface-lift)] border-[var(--border-base)] shadow-xl focus:outline-none",
          "max-h-[50dvh]",
          "data-[state=open]:animate-[bottomSheetIn_180ms_ease-out]",
          className,
        )}
        {...props}
      >
        <div className="flex min-h-0 flex-1 flex-col px-4 pt-4 pb-[calc(16px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]">
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
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

function Header({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
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

function Body({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
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

function Footer({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
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
  Header,
  Body,
  Footer,
};

export { BottomSheet };
export type { BottomSheetContentProps, BottomSheetTitleProps };
